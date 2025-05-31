const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { OpenAI } = require("openai");
const { GoalBlock, GoalNear, GoalFollow } = goals;
const blockTranslations = require("./blockTranslations.js");
const path = require("path");
require("dotenv").config(); // Carga variables de entorno desde .env

const CHAT_COMMAND_PREFIX = process.env.COMMAND || "!"; // Usa el prefijo del .env o "!" por defecto
const BOT_COMMAND_PREFIX = (process.env.COMMAND || "!") + "rodent "; // Unificamos el prefijo

// Configurar el cliente de Shapes
const shapes_client = new OpenAI({
	apiKey: process.env.SHAPES_API_KEY, // Usa una variable de entorno para la API Key
	baseURL: "https://api.shapes.inc/v1",
});

// Importar el diccionario de traducciones desde el archivo blockTranslations.js
console.log(
	`Se cargaron ${
		Object.keys(blockTranslations).length
	} traducciones de bloques desde blockTranslations.js`
);

// Crear el bot de Minecraft
const bot = mineflayer.createBot({
	//host: process.env.SERVER_IP, // Dirección del servidor
	//port: process.env.SERVER_PORT, // Puerto del servidor
	host: "localhost",
	port: 25565,
	username: "RodentBot",
});

// Variables de estado
let movements;
let followingPlayer = null;
let playerToDefend = null; // Jugador al que el bot está protegiendo
let defenseIntervalId = null; // ID del intervalo para el bucle de defensa
const DEFENSE_RADIUS = 15; // Radio en bloques para buscar enemigos alrededor del jugador.
const DEFENSE_TICK_RATE = 1000; // Milisegundos entre cada chequeo de defensa (para protegeme)
let staying = false;
let selfDefenseIntervalId = null; // ID del intervalo para el bucle de auto-defensa
const SELF_DEFENSE_RADIUS = 10; // Radio más corto para amenazas directas al bot
const SELF_DEFENSE_TICK_RATE = 1500; // Chequeo un poco menos frecuente que protegeme
const FLEE_DISTANCE = 15; // Distancia a la que intentará huir

// --- Variables para la Cola de Comandos ---
let commandQueue = [];
let currentCommand = null; // { name: string, func: async function, args: array, username: string }
let isBotDefendingItself = false; // true si el bot está activamente en modo de autodefensa

// Error específico para interrupciones
const INTERRUPTED_FOR_DEFENSE_ERROR = "INTERRUPTED_FOR_DEFENSE";

let currentSelfDefenseTarget = null; // Para rastrear el objetivo actual en auto-defensa
let announcedSelfDefenseActionForTarget = false; // Para saber si ya se anunció la acción para el objetivo actual
bot.on("spawn", () => {
	console.log("Bot conectado, obteniendo versión...");
	console.log("Versión del bot:", bot.version);

	// Cargar el plugin pathfinder después del spawn
	bot.loadPlugin(pathfinder);

	movements = new Movements(bot, bot.registry);
	bot.pathfinder.setMovements(movements);

	bot.chat("RodentBot reportandose para la aventura.");

	// Iniciar el bucle de auto-defensa
	console.log("Iniciando bucle de auto-defensa...");
	selfDefenseIntervalId = setInterval(selfDefenseLoop, SELF_DEFENSE_TICK_RATE);
});

// Función para obtener respuesta de la IA
async function getShapeResponse(prompt) {
	try {
		const response = await shapes_client.chat.completions.create({
			model: process.env.MODEL_NAME,
			messages: [{ role: "user", content: prompt }],
		});
		return response.choices[0].message.content;
	} catch (error) {
		console.error("Error en la API de Shapes:", error);
		return "Lo siento, no pude procesar tu mensaje.";
	}
}

// Función para detener la defensa
function stopDefense(informPlayer = true) {
	if (defenseIntervalId) {
		clearInterval(defenseIntervalId);
		defenseIntervalId = null;
	}
	if (playerToDefend && informPlayer) {
		// El mensaje de que se detiene la protección se maneja usualmente en el comando que llama a stopDefense
		// bot.chat(`Defensa detenida para ${playerToDefend.username}.`);
	}
	playerToDefend = null;
	// No detenemos el pathfinder aquí para no interferir con otros comandos como "sigueme"
}

// --- Funciones de Auto-Defensa ---

// Función para encontrar la mejor espada (se mantiene para la lógica de huida)
function findBestSword() {
	const swordNames = [
		"diamond_sword",
		"netherite_sword",
		"iron_sword",
		"stone_sword",
		"golden_sword", // Añadido por si acaso
		"wooden_sword",
	];
	for (const swordName of swordNames) {
		const sword = itemByName(swordName);
		if (sword) {
			return sword;
		}
	}
	return null;
}

async function ensureBestGear(forSelfDefense = false) {
	const armorSlots = {
		head: "helmet",
		torso: "chestplate",
		legs: "leggings",
		feet: "boots",
	};
	// De mejor a peor. Ajusta si usas mods con otros tiers.
	const armorTiers = [
		"netherite",
		"diamond",
		"iron",
		"golden",
		"chainmail",
		"leather",
	];
	const weaponTiers = [
		"netherite_sword",
		"diamond_sword",
		"iron_sword",
		"stone_sword",
		"golden_sword",
		"wooden_sword",
	];

	const chatPrefix = forSelfDefense
		? "[Auto-Defensa Gear] "
		: "[Protección Gear] ";
	const giveCommandUser = bot.username; // El bot se da los ítems a sí mismo

	// Equipar Armadura
	for (const slot in armorSlots) {
		const pieceType = armorSlots[slot]; // ej: "helmet"
		let bestPieceForSlot = null;
		let currentBestTierIndex = armorTiers.length; // Peor que el peor

		// 1. Verificar qué tiene equipado actualmente
		const equippedItem = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
		if (equippedItem) {
			for (let i = 0; i < armorTiers.length; i++) {
				if (equippedItem.name === `${armorTiers[i]}_${pieceType}`) {
					bestPieceForSlot = equippedItem;
					currentBestTierIndex = i;
					break;
				}
			}
		}

		// 2. Buscar en inventario una pieza mejor que la equipada (o si no hay nada equipado)
		for (let i = 0; i < currentBestTierIndex; i++) {
			// Solo buscar tiers mejores
			const tier = armorTiers[i];
			const fullItemName = `${tier}_${pieceType}`;
			const itemInInventory = itemByName(fullItemName);
			if (itemInInventory) {
				bestPieceForSlot = itemInInventory;
				currentBestTierIndex = i; // Actualizar al mejor encontrado
				// console.log(`${chatPrefix}Encontró ${fullItemName} en inventario para ${slot}.`);
				break; // Encontró la mejor posible en inventario para este slot
			}
		}

		// 3. Si no tiene armadura de diamante o mejor (o nada), y no está en creativo, intentar /give
		const diamondTierIndex = armorTiers.indexOf("diamond");
		if (
			currentBestTierIndex > diamondTierIndex &&
			bot.game.gameMode !== "creative"
		) {
			const diamondPieceName = `diamond_${pieceType}`;
			// Solo intentar /give si no tiene ya la pieza de diamante o mejor
			let hasDiamondOrBetter = false;
			if (bestPieceForSlot) {
				const tierOfBestPiece = bestPieceForSlot.name.split("_")[0];
				if (armorTiers.indexOf(tierOfBestPiece) <= diamondTierIndex) {
					hasDiamondOrBetter = true;
				}
			}

			if (!hasDiamondOrBetter) {
				bot.chat(`/give ${giveCommandUser} minecraft:${diamondPieceName}`);
				await new Promise((resolve) => setTimeout(resolve, 1500)); // Esperar a que el ítem aparezca

				const newItem = itemByName(diamondPieceName);
				if (newItem) {
					bestPieceForSlot = newItem;
					currentBestTierIndex = diamondTierIndex;
					// console.log(`${chatPrefix}Obtuvo ${diamondPieceName} vía /give.`);
				} else {
					console.log(
						`${chatPrefix}No pude obtener ${diamondPieceName} con /give.`
					);
				}
			}
		}

		// 4. Equipar la mejor armadura encontrada/obtenida (si es diferente de la actual o no había nada)
		if (
			bestPieceForSlot &&
			(!equippedItem || equippedItem.type !== bestPieceForSlot.type)
		) {
			try {
				// console.log(`${chatPrefix}Intentando equipar ${bestPieceForSlot.displayName} en ${slot}. Actual: ${equippedItem ? equippedItem.displayName : 'nada'}`);
				await bot.equip(bestPieceForSlot, slot);
				// Se comenta para reducir spam. El jugador verá el cambio visualmente.
				// bot.chat(
				// 	`${chatPrefix}Equipado ${bestPieceForSlot.displayName} en ${slot}.`
				// );
			} catch (err) {
				bot.chat(
					`${chatPrefix}Error al equipar ${bestPieceForSlot.displayName} en ${slot}: ${err.message}`
				);
				console.error(
					`${chatPrefix}Error equipando ${bestPieceForSlot.name} en ${slot}:`,
					err
				);
			}
		}
	}

	// Equipar Espada
	let bestSword = null;
	let currentBestSwordTierIndex = weaponTiers.length;

	// 1. Verificar espada actual
	const currentWeapon = bot.heldItem;
	if (currentWeapon) {
		for (let i = 0; i < weaponTiers.length; i++) {
			if (currentWeapon.name === weaponTiers[i]) {
				bestSword = currentWeapon;
				currentBestSwordTierIndex = i;
				break;
			}
		}
	}

	// 2. Buscar mejor espada en inventario
	for (let i = 0; i < currentBestSwordTierIndex; i++) {
		// Solo buscar tiers mejores
		const swordName = weaponTiers[i];
		const itemInInventory = itemByName(swordName);
		if (itemInInventory) {
			bestSword = itemInInventory;
			currentBestSwordTierIndex = i;
			// console.log(`${chatPrefix}Encontró ${swordName} en inventario.`);
			break;
		}
	}

	// 3. Si no tiene espada de diamante o mejor, y no está en creativo, intentar /give
	const diamondSwordTierIndex = weaponTiers.indexOf("diamond_sword");
	if (
		currentBestSwordTierIndex > diamondSwordTierIndex &&
		bot.game.gameMode !== "creative"
	) {
		let hasDiamondOrBetterSword = false;
		if (bestSword) {
			// Para espadas, el nombre es directo, no "tier_sword"
			if (weaponTiers.indexOf(bestSword.name) <= diamondSwordTierIndex) {
				hasDiamondOrBetterSword = true;
			}
		}
		if (!hasDiamondOrBetterSword) {
			bot.chat(`/give ${giveCommandUser} minecraft:diamond_sword`);
			await new Promise((resolve) => setTimeout(resolve, 1500));

			const newSword = itemByName("diamond_sword");
			if (newSword) {
				bestSword = newSword;
				currentBestSwordTierIndex = diamondSwordTierIndex;
				// console.log(`${chatPrefix}Obtuvo diamond_sword vía /give.`);
			} else {
				console.log(`${chatPrefix}No pude obtener diamond_sword con /give.`);
			}
		}
	}

	// 4. Equipar la mejor espada
	if (bestSword && (!currentWeapon || currentWeapon.type !== bestSword.type)) {
		try {
			// console.log(`${chatPrefix}Intentando equipar ${bestSword.displayName}. Actual: ${currentWeapon ? currentWeapon.displayName : 'nada'}`);
			await bot.equip(bestSword, "hand");
			// Se comenta para reducir spam.
			// bot.chat(`${chatPrefix}Equipado ${bestSword.displayName} en mano.`);
		} catch (err) {
			bot.chat(
				`${chatPrefix}Error al equipar ${bestSword.displayName}: ${err.message}`
			);
			console.error(`${chatPrefix}Error equipando ${bestSword.name}:`, err);
		}
	}
}

async function selfDefenseLoop() {
	// No hacer nada si el bot no está completamente cargado o no tiene entidad
	// o si está en modo "quedate" y no queremos que la autodefensa lo mueva (esto se maneja más abajo)
	if (!bot.entity || !bot.registry) return;

	const commonHostilesString = process.env.COMMON_HOSTILES || "";
	const commonHostiles = commonHostilesString
		.split(",")
		.map((mob) => mob.trim().toLowerCase())
		.filter((mob) => mob.length > 0);

	let nearestHostileToBot = null;
	let minDistanceSqToBot = SELF_DEFENSE_RADIUS * SELF_DEFENSE_RADIUS;

	for (const entityId in bot.entities) {
		const entity = bot.entities[entityId];
		if (!entity || entity === bot.entity) continue;

		const entityNameLower = entity.name ? entity.name.toLowerCase() : null;
		if (entityNameLower && commonHostiles.includes(entityNameLower)) {
			const distanceSq = bot.entity.position.distanceSquared(entity.position);
			if (distanceSq < minDistanceSqToBot) {
				minDistanceSqToBot = distanceSq;
				nearestHostileToBot = entity;
			}
		}
	}

	if (nearestHostileToBot) {
		if (!isBotDefendingItself) {
			// Primera vez que detecta una amenaza en este "encuentro"
			isBotDefendingItself = true;
			if (currentCommand) {
				bot.chat(
					`¡Autodefensa activada! Pausando comando actual: ${currentCommand.name}.`
				);
				bot.pathfinder.stop(); // Intentar interrumpir el pathfinding del comando actual
			}
		}

		if (staying) {
			bot.chat("¡Amenaza detectada! Anulando 'quedate' para defenderme.");
			staying = false; // La autodefensa tiene prioridad sobre "quedate"
		}
		await ensureBestGear(true); // Asegurarse de tener el mejor equipo

		// Comprobar si el nearestHostileToBot es diferente del currentSelfDefenseTarget
		// o si no teníamos un currentSelfDefenseTarget "fijado".
		if (
			currentSelfDefenseTarget === null ||
			currentSelfDefenseTarget.id !== nearestHostileToBot.id
		) {
			currentSelfDefenseTarget = nearestHostileToBot; // Actualizar/fijar el objetivo
			announcedSelfDefenseActionForTarget = false;
		}

		const bestSword = findBestSword();
		console.log(
			`[Self-Defense] Result of findBestSword(): ${
				bestSword ? bestSword.name : "null"
			}`
		); // Log para ver qué se encontró

		if (bestSword) {
			// Luchar
			if (!announcedSelfDefenseActionForTarget) {
				bot.chat(
					`¡${
						nearestHostileToBot.name || nearestHostileToBot.displayName
					} detectado! Preparándome para atacar...`
				);
				announcedSelfDefenseActionForTarget = true;
			}
			try {
				await bot.equip(bestSword, "hand");
				bot.pathfinder.setGoal(new GoalFollow(nearestHostileToBot, 1.5), true);
				bot.attack(nearestHostileToBot, true);
			} catch (err) {
				console.error("Error al equipar o atacar en auto-defensa:", err);
				bot.chat("Tuve problemas para equipar mi espada y defenderme.");
				announcedSelfDefenseActionForTarget = false; // Permitir re-anunciar si hay error
			}
		} else {
			// Huir
			if (!announcedSelfDefenseActionForTarget) {
				bot.chat(
					`¡${
						nearestHostileToBot.name || nearestHostileToBot.displayName
					} demasiado cerca! Huyendo...`
				);
				announcedSelfDefenseActionForTarget = true;
			}
			const fleeVector = bot.entity.position
				.minus(nearestHostileToBot.position)
				.normalize()
				.scale(FLEE_DISTANCE);
			const fleePosition = bot.entity.position.plus(fleeVector);
			bot.pathfinder.setGoal(
				new GoalNear(fleePosition.x, fleePosition.y, fleePosition.z, 1),
				true // Objetivo dinámico por si el mob persigue
			);
		}
	} else if (isBotDefendingItself) {
		// No hay hostil cercano Y ESTABA en modo de autodefensa
		isBotDefendingItself = false;
		currentSelfDefenseTarget = null;
		announcedSelfDefenseActionForTarget = false;

		bot.chat("Amenaza neutralizada. Limpiando objetivo de autodefensa.");
		// Detener cualquier movimiento o ataque relacionado con la autodefensa
		if (bot.pathfinder.isMoving()) {
			bot.pathfinder.stop();
		}
		bot.pathfinder.setGoal(null); // Asegurarse de que no haya metas de pathfinding de defensa
		console.log(
			"DEBUG: bot object before stopAttacking:",
			typeof bot.stopAttacking,
			bot.stopAttacking
		); // Línea de depuración
		if (typeof bot.stopAttacking === "function") {
			bot.stopAttacking(); // Detener cualquier ataque en curso
		} else {
			console.error(
				"ERROR: bot.stopAttacking no es una función. No se pudo detener el ataque explícitamente."
			);
		}

		// Intentar reanudar comandos en cola
		runNextCommandFromQueue();
	}
}

// --- Fin Funciones de Auto-Defensa ---

// --- Funciones de Cola de Comandos ---
async function runCommand(commandObj) {
	currentCommand = commandObj;
	bot.chat(
		`Ejecutando comando: '${commandObj.name}' para ${commandObj.username}.`
	);
	try {
		await commandObj.func(...commandObj.args, commandObj.username); // Pasar username para contexto si es necesario
		bot.chat(`Comando '${commandObj.name}' completado.`);
	} catch (err) {
		if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR) {
			bot.chat(`Comando '${commandObj.name}' pausado debido a la autodefensa.`);
			if (currentCommand) {
				// Asegurarse de que currentCommand no haya sido nulificado
				commandQueue.unshift(currentCommand); // Poner de nuevo al inicio de la cola
			}
		} else {
			bot.chat(`Error durante el comando '${commandObj.name}': ${err.message}`);
			console.error(
				`Error ejecutando ${commandObj.name}:`,
				err.message,
				err.stack
			);
		}
	} finally {
		currentCommand = null;
		if (!isBotDefendingItself) {
			// Solo procesar el siguiente si no estamos en medio de una defensa
			runNextCommandFromQueue();
		}
	}
}

function runNextCommandFromQueue() {
	if (currentCommand || isBotDefendingItself || staying) {
		// No iniciar un nuevo comando si ya hay uno, o si se está defendiendo, o si está en "quedate"
		return;
	}
	if (commandQueue.length > 0) {
		const nextCommand = commandQueue.shift();
		runCommand(nextCommand);
	} else {
		// bot.chat("Cola de comandos vacía."); // Opcional: mensaje de depuración
	}
}

function addCommandToQueue(commandName, commandFn, args = [], username) {
	const commandObj = {
		name: commandName,
		func: commandFn,
		args: args,
		username: username,
	};

	if (staying) {
		bot.chat(
			"Estoy en modo 'quedate', no puedo aceptar nuevos comandos de movimiento o acción."
		);
		return;
	}

	if (!currentCommand && !isBotDefendingItself) {
		runCommand(commandObj);
	} else {
		commandQueue.push(commandObj);
		bot.chat(
			`Comando '${commandName}' agregado a la cola. Posición: ${commandQueue.length}.`
		);
	}
}

// --- Fin Funciones de Cola de Comandos ---

// --- Funciones de Inventario (adaptadas del ejemplo) ---

function itemToString(item) {
	if (item) {
		return `${item.name} x ${item.count}`;
	} else {
		return "(nada)";
	}
}

function itemByName(name) {
	// Intenta buscar primero usando la traducción si existe, sino el nombre directo
	const translatedName =
		blockTranslations[name.toLowerCase()] || name.toLowerCase();
	const items = bot.inventory.items();
	// En versiones 1.9+, el slot 45 es la mano secundaria (off-hand)
	if (bot.registry.isNewerOrEqualTo("1.9") && bot.inventory.slots[45]) {
		items.push(bot.inventory.slots[45]);
	}
	// Busca primero por el nombre traducido, luego por el original si no se encuentra
	let foundItem = items.find(
		(item) => item.name.toLowerCase() === translatedName
	);
	if (!foundItem) {
		foundItem = items.find(
			(item) => item.name.toLowerCase() === name.toLowerCase()
		);
	}
	return foundItem;
}

function sayItems() {
	const items = bot.inventory.items();
	if (bot.registry.isNewerOrEqualTo("1.9") && bot.inventory.slots[45]) {
		items.push(bot.inventory.slots[45]); // Incluir item en la mano secundaria
	}
	const output = items.map(itemToString).join(", ");
	if (output) {
		bot.chat("Inventario: " + output);
	} else {
		bot.chat("Inventario vacío.");
	}
}

async function tossItemCmd(itemName, amountStr) {
	const amount = amountStr ? parseInt(amountStr, 10) : null;
	const item = itemByName(itemName);

	if (!item) {
		bot.chat(`No tengo ${itemName}.`);
	} else {
		try {
			if (amount) {
				await bot.toss(item.type, null, amount);
				bot.chat(`Tiré ${amount} x ${itemName}.`);
			} else {
				await bot.tossStack(item); // Tira todo el stack
				bot.chat(`Tiré ${item.count} x ${itemName}.`);
			}
		} catch (err) {
			bot.chat(`No pude tirar el ítem: ${err.message}`);
		}
	}
}

async function equipItemCmd(itemName, destination) {
	const item = itemByName(itemName);
	if (item) {
		try {
			await bot.equip(item, destination);
			bot.chat(`Equipé ${itemName} en ${destination}.`);
		} catch (err) {
			bot.chat(`No pude equipar ${itemName}: ${err.message}`);
		}
	} else {
		bot.chat(`No tengo ${itemName}.`);
	}
}

async function unequipItemCmd(destination) {
	try {
		await bot.unequip(destination);
		bot.chat(`Desequipé el ítem de ${destination}.`);
	} catch (err) {
		bot.chat(`No pude desequipar: ${err.message}`);
	}
}

async function useItemCmd(itemName) {
	if (!itemName) {
		bot.chat("Activando ítem en mano...");
		bot.activateItem(); // Activa el ítem en la mano principal
		// Para la mano secundaria: bot.activateItem(true)
		return;
	}

	const item = itemByName(itemName);
	if (item) {
		try {
			bot.chat(`Intentando equipar y usar ${itemName}...`);
			await bot.equip(item, "hand"); // Equipar en la mano principal
			bot.chat(`Equipé ${itemName} en la mano.`);
			bot.activateItem(); // Activar el ítem recién equipado
			bot.chat(`Usé ${itemName}.`);
		} catch (err) {
			bot.chat(`No pude equipar o usar ${itemName}: ${err.message}`);
		}
	} else {
		bot.chat(`No tengo ${itemName} para usar.`);
	}
}

async function craftItemCmd(itemName, amountStr) {
	const amount = amountStr ? parseInt(amountStr, 10) : 1;
	const itemToCraft = bot.registry.itemsByName[itemName.toLowerCase()];

	if (!itemToCraft) {
		bot.chat(`Ítem desconocido: ${itemName}`);
		return;
	}

	const craftingTable = bot.findBlock({
		matching: bot.registry.blocksByName.crafting_table.id,
		maxDistance: 4, // Buscar mesa de crafteo cerca
	});

	const recipe = bot.recipesFor(
		itemToCraft.id,
		null,
		1,
		craftingTable ? craftingTable : null
	)[0];

	if (recipe) {
		bot.chat(`Puedo fabricar ${itemName}. Intentando...`);
		try {
			await bot.craft(recipe, amount, craftingTable ? craftingTable : null);
			bot.chat(`Fabricados ${amount} x ${itemName}.`);
		} catch (err) {
			bot.chat(`Error al fabricar ${itemName}: ${err.message}`);
		}
	} else {
		bot.chat(
			`No puedo fabricar ${itemName}. No tengo la receta o los materiales.`
		);
	}
}

// --- Fin Funciones de Inventario ---

// **Acciones del bot según el chat**

// Mover la lógica de "consigue" a su propia función para la cola
async function executeConsigueCommand(userInputName, usernameForContext) {
	const checkInterrupt = () => {
		if (isBotDefendingItself) throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
	};

	const englishName = blockTranslations[userInputName] || userInputName;
	const blockType = bot.registry.blocksByName[englishName];

	if (!blockType) {
		bot.chat(`No reconozco el bloque "${userInputName}".`);
		return; // Termina la ejecución de este comando
	}

	bot.chat(`Buscando ${userInputName} (como ${englishName})...`);
	const blocks = bot.findBlocks({
		matching: blockType.id,
		maxDistance: 64,
		count: 1,
	});

	if (blocks.length === 0) {
		bot.chat(`No encontré bloques de ${userInputName} cerca.`);
		return;
	}

	const targetBlockPosition = blocks[0];
	let targetBlock = bot.blockAt(targetBlockPosition);

	if (!targetBlock) {
		bot.chat(
			`El bloque de ${userInputName} en ${targetBlockPosition} ya no existe o es inaccesible.`
		);
		return;
	}

	bot.chat(
		`Encontré ${userInputName} en ${targetBlockPosition.x}, ${targetBlockPosition.y}, ${targetBlockPosition.z}. Intentando ir y minarlo.`
	);

	const returnPosition = bot.entity.position.clone();

	try {
		checkInterrupt();
		await bot.pathfinder.goto(
			new GoalNear(
				targetBlockPosition.x,
				targetBlockPosition.y,
				targetBlockPosition.z,
				1
			)
		);
		checkInterrupt();
		bot.chat(`Llegué al bloque de ${userInputName}.`);

		targetBlock = bot.blockAt(targetBlockPosition);
		if (!targetBlock || targetBlock.type !== blockType.id) {
			bot.chat("El bloque objetivo cambió o desapareció al llegar. Abortando.");
			await bot.pathfinder.goto(
				new GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1)
			); // Intenta regresar
			checkInterrupt();
			bot.chat("He vuelto (después de bloque desaparecido).");
			return;
		}

		const creativeMode = bot.game.gameMode === "creative";
		let canDigNow = creativeMode || bot.canDigBlock(targetBlock);

		// Lógica mejorada para obtener herramientas si son necesarias
		if (
			!canDigNow && // Si aún no puede minar
			targetBlock.material &&
			bot.registry.materials[targetBlock.material]?.harvestTools && // Y el material requiere herramientas
			!creativeMode // Y no está en modo creativo
		) {
			bot.chat(
				`Necesito una herramienta adecuada para ${userInputName}. Verificando y obteniendo si es necesario...`
			);

			const potentialTools = [];
			const materialName = targetBlock.name.toLowerCase();

			// Determinar si un hacha es prioritaria
			const needsAxe =
				materialName.includes("log") ||
				materialName.includes("planks") ||
				materialName.includes("wood") ||
				materialName.includes("fence") ||
				materialName.includes("door") ||
				materialName.includes("crafting_table") ||
				materialName.includes("chest") ||
				materialName.includes("bookshelf");

			if (needsAxe) {
				potentialTools.push({
					name: "diamond_axe",
					giveCmd: `minecraft:diamond_axe`,
					type: "hacha",
				});
			}
			// Siempre considerar un pico si se necesita una herramienta (a menos que el hacha ya haya funcionado)
			potentialTools.push({
				name: "diamond_pickaxe",
				giveCmd: `minecraft:diamond_pickaxe`,
				type: "pico",
			});

			for (const toolDetail of potentialTools) {
				if (canDigNow) break; // Si una herramienta de una iteración anterior funcionó

				let tool = itemByName(toolDetail.name);
				if (!tool) {
					bot.chat(
						`No tengo ${toolDetail.type} de diamante (${toolDetail.name}). Intentando obtenerlo con /give...`
					);
					bot.chat(`/give ${bot.username} ${toolDetail.giveCmd}`);
					await new Promise((resolve) => setTimeout(resolve, 2000)); // Esperar a que el ítem aparezca
					checkInterrupt();
					tool = itemByName(toolDetail.name); // Volver a verificar
				}

				if (tool) {
					bot.chat(
						`Tengo ${toolDetail.type} de diamante (${toolDetail.name}). Intentando equipar...`
					);
					await bot.equip(tool, "hand");
					checkInterrupt();
					if (bot.canDigBlock(targetBlock)) {
						canDigNow = true;
						bot.chat(`${toolDetail.type} de diamante equipado y es adecuado.`);
						break; // Herramienta equipada y funciona
					} else {
						bot.chat(
							`${toolDetail.type} de diamante equipado, pero no es el adecuado para este bloque o no es suficiente.`
						);
					}
				} else {
					bot.chat(
						`No pude encontrar u obtener ${toolDetail.type} de diamante (${toolDetail.name}) después del intento de /give.`
					);
				}
			}
		}

		if (canDigNow) {
			checkInterrupt();
			bot.chat(`Minando ${userInputName}...`);
			await bot.dig(targetBlock);
			// Esperar un momento para que el bot recoja el bloque minado
			bot.chat("Esperando a recoger el bloque...");
			await new Promise((resolve) => setTimeout(resolve, 1500)); // Espera 1.5 segundos
			checkInterrupt();
			bot.chat(`¡Miné ${userInputName}!`);
		} else {
			bot.chat(
				`No puedo minar ${userInputName}. Puede que necesite una herramienta específica o no tenga permisos.`
			);
		}

		bot.chat("Regresando a la posición original...");
		await bot.pathfinder.goto(
			new GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1)
		);
		checkInterrupt();
		bot.chat("He vuelto.");
	} catch (err) {
		if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR) {
			throw err; // Propagar para que runCommand lo maneje
		}
		// Si el error es por pathfinding interrumpido Y estamos en autodefensa, tratarlo como interrupción
		if (
			isBotDefendingItself &&
			(err.message.toLowerCase().includes("pathfinding interrupted") ||
				err.message.toLowerCase().includes("goal interrupted") || // For general goal interruptions
				err.message.toLowerCase().includes("goalchanged") || // Specifically for "GoalChanged"
				err.message.toLowerCase().includes("dig interrupted"))
		) {
			console.log(
				"Comando 'consigue' interpretado como interrumpido por pathfinder/dig durante defensa."
			);
			throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
		}

		console.error(
			`Error en 'executeConsigueCommand' para ${userInputName}:`,
			err
		);
		bot.chat(
			`Ocurrió un error al intentar conseguir ${userInputName}: ${err.message}`
		);
		try {
			bot.chat(
				"Intentando regresar a la posición original después de un error..."
			);
			await bot.pathfinder.goto(
				new GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1)
			);
			// No necesitamos checkInterrupt() aquí ya que estamos en un bloque catch de error no relacionado con defensa.
			bot.chat("He vuelto (después de error).");
		} catch (returnErr) {
			console.error(
				"Error al intentar regresar después de un error en consigue:",
				returnErr
			);
			bot.chat("No pude regresar a la posición original después del error.");
		}
		// No relanzar err directamente si queremos que el comando se considere fallido y no re-encolado
		// a menos que sea INTERRUPTED_FOR_DEFENSE_ERROR
	}
}

// **Acciones del bot según el chat**
bot.on("chat", async (username, message) => {
	if (username === bot.username) return;

	// Convertir el mensaje a minúsculas para evitar problemas con mayúsculas
	const msgLower = message.toLowerCase();

	// Manejar comandos generales del bot !rodent <comando>
	if (msgLower.startsWith(BOT_COMMAND_PREFIX)) {
		console.log("Bot Command recibido de " + username + ": " + message);
		const commandString = msgLower.substring(BOT_COMMAND_PREFIX.length).trim();
		const args = commandString.split(" ");
		const command = args.shift()?.toLowerCase(); // El primer elemento es el comando, el resto son argumentos. Convertir a minúsculas.

		if (command === "sigueme") {
			// Detener comandos actuales y limpiar cola para seguir
			if (currentCommand) {
				bot.pathfinder.stop();
				bot.chat(`Comando '${currentCommand.name}' cancelado para seguirte.`);
				currentCommand = null;
			}
			commandQueue = [];
			staying = false;
			isBotDefendingItself = false; // Salir de modo defensa si estaba activo

			const player = bot.players[username];
			if (player && player.entity) {
				followingPlayer = player;
				bot.chat(`¡Te seguiré, ${username}!`);
				bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
				stopDefense(false); // Detener la protección de otro jugador si estaba activa
			} else {
				bot.chat(`No puedo encontrarte para seguirte, ${username}.`);
			}
		} else if (command === "quedate") {
			staying = true;
			bot.chat("¡Me quedaré aquí!");
			bot.pathfinder.setGoal(null); // Detiene el movimiento
			if (currentCommand) {
				bot.chat(
					`Comando '${currentCommand.name}' cancelado para quedarme quieto.`
				);
				// No se re-encola, "quedate" tiene prioridad
				currentCommand = null;
			}
			commandQueue = []; // Limpiar la cola de comandos
			bot.chat("Cola de comandos limpiada.");
		} else if (command === "ven") {
			const player = bot.players[username];
			if (player && player.entity) {
				bot.pathfinder.setGoal(
					new GoalNear(
						player.entity.position.x,
						player.entity.position.y,
						player.entity.position.z,
						1
					)
				);
				// "ven" podría ser un comando encolable si se desea
				bot.chat(`¡Voy hacia ti, ${username}!`);
			} else {
				bot.chat("No puedo ir hacia ti porque no te encuentro.");
			}
		} else if (command === "ve") {
			if (args.length === 3) {
				// !rodent ve x y z
				const x = parseInt(args[0]);
				const y = parseInt(args[1]);
				const z = parseInt(args[2]);
				if (isNaN(x) || isNaN(y) || isNaN(z)) {
					bot.chat("Las coordenadas no son válidas.");
				} else {
					addCommandToQueue(
						"ve_coords",
						async (x, y, z) => {
							bot.pathfinder.setGoal(new GoalBlock(x, y, z));
							bot.chat(`¡Voy a las coordenadas ${x}, ${y}, ${z}!`); // Este chat es inmediato, el movimiento es asíncrono
						},
						[x, y, z],
						username
					);
				}
			} else if (args.length === 1) {
				// !rodent ve <jugador>
				const targetPlayer = args[0];
				const player = bot.players[targetPlayer];
				if (player && player.entity) {
					bot.pathfinder.setGoal(
						new GoalNear(
							player.entity.position.x,
							player.entity.position.y,
							player.entity.position.z,
							1
						)
					);
					bot.chat(`¡Voy hacia ${targetPlayer}!`);
				} else {
					bot.chat(`No encuentro al jugador ${targetPlayer}.`);
				}
			} else if (args.length === 0 && followingPlayer) {
				// !rodent ve (sin args, si está siguiendo a alguien)
				// Ir hacia el jugador que está siguiendo actualmente
				if (followingPlayer.entity) {
					bot.pathfinder.setGoal(
						new GoalNear(
							followingPlayer.entity.position.x,
							followingPlayer.entity.position.y,
							followingPlayer.entity.position.z,
							1
						)
					);
					bot.chat(`¡Voy hacia ${followingPlayer.username}!`);
				} else {
					bot.chat(
						`Estaba siguiendo a ${followingPlayer.username} pero ya no lo encuentro.`
					);
					followingPlayer = null;
				}
			} else {
				bot.chat(
					`Uso correcto: ${BOT_COMMAND_PREFIX}ve <x> <y> <z> o ${BOT_COMMAND_PREFIX}ve <jugador>`
				);
			}
		} else if (command === "aplana") {
			// Mover la lógica de "aplana" a su propia función para la cola
			async function executeAplanаCommand(size, usernameForContext) {
				bot.chat(
					`¡Voy a aplanar un área de ${size}x${size} bloques alrededor mío!`
				);
				const botY = Math.floor(bot.entity.position.y);
				for (let dy = -1; dy <= 0; dy++) {
					for (
						let dx = -Math.floor(size / 2);
						dx <= Math.floor(size / 2);
						dx++
					) {
						for (
							let dz = -Math.floor(size / 2);
							dz <= Math.floor(size / 2);
							dz++
						) {
							if (isBotDefendingItself)
								throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR); // Verificar interrupción
							const blockPos = bot.entity.position.offset(dx, dy, dz);
							const block = bot.blockAt(blockPos);
							if (block && block.name !== "air" && bot.canDigBlock(block)) {
								try {
									await bot.dig(block);
								} catch (err) {
									if (isBotDefendingItself)
										throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
									console.error(
										`Error al picar bloque en ${blockPos}:`,
										err.message
									);
									bot.chat(
										`Error al picar ${block.displayName}: ${err.message}`
									);
								}
							}
						}
					}
				}
				bot.chat("¡Área aplanada!");
			}
			if (args.length === 1) {
				const size = parseInt(args[0]);
				if (isNaN(size) || size < 1 || size > 10) {
					bot.chat(
						`Indica un tamaño válido (1-10). Ejemplo: ${BOT_COMMAND_PREFIX}aplana 3`
					);
					return;
				}
				addCommandToQueue("aplana", executeAplanаCommand, [size], username);
			} else {
				bot.chat(`Uso correcto: ${BOT_COMMAND_PREFIX}aplana <tamaño>`);
			}
		} else if (command === "consigue") {
			if (args.length >= 1) {
				const userInputName = args.join(" ").toLowerCase(); // Permite nombres con espacios y convierte a minúsculas
				addCommandToQueue(
					"consigue",
					executeConsigueCommand,
					[userInputName],
					username
				);
			} else {
				bot.chat(`Uso correcto: ${BOT_COMMAND_PREFIX}consigue <nombre_bloque>`);
			}
		} else if (command === "protegeme") {
			const player = bot.players[username];
			if (!player || !player.entity) {
				bot.chat(`No te encuentro, ${username}.`);
				return;
			}

			// Si el bot estaba en modo "quedate", desactivarlo para permitir el movimiento de defensa.
			if (staying) {
				staying = false;
				bot.chat("Dejaré de estar quieto para poder protegerte mejor.");
			}

			// Detener comandos actuales y limpiar cola para proteger
			if (currentCommand) {
				bot.pathfinder.stop();
				bot.chat(`Comando '${currentCommand.name}' cancelado para protegerte.`);
				currentCommand = null;
			}
			commandQueue = [];
			if (playerToDefend && playerToDefend.username === username) {
				bot.chat(`Ya te estoy protegiendo, ${username}.`);
				return;
			}

			stopDefense(false); // Detener cualquier defensa anterior sin notificar (la nueva notificación lo cubrirá)

			playerToDefend = player; // player es bot.players[username]
			console.log(
				`[Defensa] Iniciando defensa para ${username}. Jugador:`,
				playerToDefend
			);
			console.log(
				`[Defensa] Entidad del jugador a defender:`,
				playerToDefend.entity ? "Existe" : "NO Existe",
				playerToDefend.entity
			);

			bot.chat(
				`¡Entendido, ${username}! Te protegeré de los monstruos cercanos.`
			);
			defenseIntervalId = setInterval(async () => {
				// Hacer el callback async
				// console.log(`[Defensa Tick] Verificando para ${playerToDefend ? playerToDefend.username : 'nadie (playerToDefend es null)'}.`);
				if (
					!playerToDefend ||
					!playerToDefend.entity ||
					playerToDefend.entity.health === 0 ||
					!bot.players[playerToDefend.username]
				) {
					if (playerToDefend) {
						// Este log es importante para saber por qué se detuvo
						console.log(
							`[Defensa Tick] Condición de parada temprana. Usuario: ${
								playerToDefend.username
							}, Entidad: ${playerToDefend.entity ? "OK" : "Falta"}, Salud: ${
								playerToDefend.entity ? playerToDefend.entity.health : "N/A"
							}, En bot.players: ${!!bot.players[playerToDefend.username]}`
						);
						bot.chat(
							`Dejando de proteger a ${playerToDefend.username} (ya no está disponible o ha muerto).`
						);
					} else {
						console.log(
							"[Defensa Tick] playerToDefend es null, deteniendo intervalo de defensa."
						);
					}
					stopDefense(false);
					return;
				}
				// console.log(`[Defensa Tick] ${playerToDefend.username} está OK. Buscando hostiles cerca de ${playerToDefend.entity.position}. Entidades totales: ${Object.keys(bot.entities).length}`);
				let nearestHostile = null;
				let minDistanceSq = DEFENSE_RADIUS * DEFENSE_RADIUS; // Usar distancia cuadrada para eficiencia

				for (const entityId in bot.entities) {
					const entity = bot.entities[entityId];
					if (
						!entity ||
						entity === bot.entity ||
						entity === playerToDefend.entity
					)
						// Añadido !entity por si acaso
						continue;
					let isHostile = false;
					const entityNameLower = entity.name
						? entity.name.toLowerCase()
						: null;

					// Leer la lista de mobs hostiles desde el archivo .env
					// Proporciona una lista vacía por defecto si la variable no está definida.
					const commonHostilesString = process.env.COMMON_HOSTILES || "";
					const commonHostiles = commonHostilesString
						.split(",")
						.map((mob) => mob.trim().toLowerCase())
						.filter((mob) => mob.length > 0);

					// La entidad se considera hostil si su nombre (en minúsculas) está en la lista commonHostiles.
					if (entityNameLower && commonHostiles.includes(entityNameLower)) {
						isHostile = true;
					}

					// console.log(`[Defensa Eval] Entidad: ${entity.name || entity.displayName || entity.type}, Tipo: ${entity.type}, Kind: ${entity.kind}, ¿Es Hostil?: ${isHostile}`);

					if (isHostile) {
						// console.log(`[Defensa Tick] Entidad hostil potencial: ${entity.name || entity.displayName} (${entity.type}, ${entity.kind}) en ${entity.position}`);
						const distanceSq = playerToDefend.entity.position.distanceSquared(
							entity.position
						);
						// console.log(`[Defensa Tick] Distancia cuadrada a ${entity.name || entity.displayName}: ${distanceSq} (RadioSq: ${minDistanceSq})`);
						if (distanceSq < minDistanceSq) {
							minDistanceSq = distanceSq;
							nearestHostile = entity;
						}
					}
				}

				if (nearestHostile) {
					await ensureBestGear(false); // Asegurarse de tener el mejor equipo

					// Establecer el objetivo de seguir al hostil para asegurar el movimiento.
					// El '1.5' es la distancia a la que el bot intentará mantenerse del objetivo mientras lo sigue.
					// Un valor más pequeño lo acercará más, permitiendo el ataque.
					const goal = new GoalFollow(nearestHostile, 1.5);
					bot.pathfinder.setGoal(goal, true); // El segundo 'true' es para objetivos dinámicos (el mob se mueve)

					console.log(
						`[Defensa Tick] Hostil más cercano encontrado: ${
							nearestHostile.name || nearestHostile.displayName
						} (${nearestHostile.type}). Siguiendo y Atacando.`
					);
					bot.attack(nearestHostile, true); // Añadido 'true' como en el ejemplo
				} else {
					// No hay hostiles cercanos al jugador protegido.
					// Si el bot tenía un objetivo de pathfinder (ej. seguir a un hostil anterior), lo cancelamos.
					if (bot.pathfinder.goal) {
						// Verifica si hay un objetivo activo
						bot.pathfinder.setGoal(null);
					}
					console.log(
						`[Defensa Tick] No se encontraron hostiles dentro del radio para ${
							playerToDefend
								? playerToDefend.username
								: "N/A (playerToDefend es null)"
						}.`
					);
				}
			}, DEFENSE_TICK_RATE);
		} else if (
			command === "no_protejas" ||
			command === "parar_proteccion" ||
			command === "detener_proteccion"
		) {
			if (playerToDefend) {
				bot.chat(`De acuerdo, ${playerToDefend.username}, ya no te protegeré.`);
				stopDefense();
			} else {
				bot.chat("No estaba protegiendo a nadie.");
			}
		} else if (command === "reanuda") {
			staying = false;
			bot.chat("¡Listo para moverte de nuevo!");
			runNextCommandFromQueue(); // Intentar procesar la cola si algo estaba pendiente
		} else if (command === "chat") {
			const prompt = args.join(" ").trim();
			if (prompt) {
				console.log("AI Chat Command recibido de " + username + ": " + prompt);
				bot.chat(await getShapeResponse(prompt));
			} else {
				bot.chat(
					`Por favor, escribe algo después de ${BOT_COMMAND_PREFIX}chat.`
				);
			}
		} else if (command === "inventario" || command === "list") {
			sayItems();
		} else if (command === "dame" || command === "tira") {
			// Formato: !rodent tirar <nombre_item> [cantidad]
			// Ej: !rodent tirar piedra 5  O  !rodent tirar diamante
			async function executeDameCommand(
				itemName,
				amountStr,
				usernameForContext
			) {
				const player = bot.players[usernameForContext];
				if (player && player.entity) {
					bot.chat(
						`¡Entendido, ${usernameForContext}! Voy hacia ti para darte ${itemName}.`
					);
					try {
						if (isBotDefendingItself)
							throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
						await bot.pathfinder.goto(
							new GoalNear(
								player.entity.position.x,
								player.entity.position.y,
								player.entity.position.z,
								2
							)
						);
						if (isBotDefendingItself)
							throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
						bot.chat(
							`Llegué, ${usernameForContext}. Aquí tienes tu ${itemName}.`
						);
						await tossItemCmd(itemName, amountStr); // tossItemCmd es síncrono o asíncrono? Asumimos que es rápido.
					} catch (err) {
						if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR) throw err;
						console.error(
							`Error al ir hacia ${usernameForContext} o tirar el ítem:`,
							err
						);
						bot.chat(
							`Tuve problemas para acercarme o tirar el ítem: ${err.message}. Lo soltaré aquí.`
						);
						await tossItemCmd(itemName, amountStr);
					}
				} else {
					bot.chat(
						`No te encuentro, ${usernameForContext}. Dejaré ${itemName} aquí.`
					);
					await tossItemCmd(itemName, amountStr);
				}
			}

			if (args.length >= 1) {
				const itemName = args[0].toLowerCase(); // Asegurar minúsculas para la traducción
				const amountStr = args[1];
				addCommandToQueue(
					"dame",
					executeDameCommand,
					[itemName, amountStr],
					username
				);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}dame <nombre_item> [cantidad]`);
			}
		} else if (command === "equipar" || command === "equip") {
			// Formato: !rodent equipar <destino> <nombre_item>
			// Destinos comunes: hand, head, torso, legs, feet, off-hand
			// Ej: !rodent equipar hand espada_diamante
			if (args.length === 2) {
				const destination = args[0].toLowerCase();
				const itemName = args[1];
				// equipItemCmd es rápido, no necesita estar en la cola principal de tareas largas
				equipItemCmd(itemName, destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}equipar <destino> <nombre_item>`);
			}
		} else if (command === "desequipar" || command === "unequip") {
			// Formato: !rodent desequipar <destino>
			// Ej: !rodent desequipar hand
			if (args.length === 1) {
				const destination = args[0].toLowerCase();
				// unequipItemCmd es rápido
				unequipItemCmd(destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}desequipar <destino>`);
			}
		} else if (command === "usar" || command === "use") {
			// Ahora puede aceptar un nombre de ítem
			// Formato: !rodent usar [nombre_item]
			// Ej: !rodent usar espada_diamante  O  !rodent usar (para usar lo que tenga en mano)
			const itemName = args[0]; // Puede ser undefined si solo se escribe "!rodent usar"
			// useItemCmd es relativamente rápido
			useItemCmd(itemName); // No se pasa username, ya que usa el inventario del bot
		} else if (command === "fabricar" || command === "craft") {
			// Formato: !rodent fabricar <nombre_item> [cantidad]
			// Ej: !rodent fabricar palo 4
			if (args.length >= 1) {
				const itemName = args[0];
				const amountStr = args[1]; // Puede ser undefined
				// craftItemCmd puede implicar ir a una mesa, pero por ahora lo tratamos como rápido
				craftItemCmd(itemName, amountStr);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}fabricar <nombre_item> [cantidad]`);
			}
		} else if (command === "ayuda") {
			bot.chat(
				`Comandos: ${BOT_COMMAND_PREFIX}sigueme, quedate, ven, ve, aplana, consigue, protegeme, no_protejas, reanuda, inventario, dame, equipar, desequipar, usar, fabricar. Para IA: ${BOT_COMMAND_PREFIX}chat <mensaje>.`
			);
		} else {
			bot.chat(
				`No reconozco el comando '${command}'. Usa '${BOT_COMMAND_PREFIX}ayuda' para ver los disponibles.`
			);
		}
	}
});

// Eventos adicionales
bot.on("death", () => {
	bot.chat("¡Oh no! Volveré pronto.");
	stopDefense(false); // Detener la defensa si el bot muere, sin notificar al jugador (ya está muerto)
	if (selfDefenseIntervalId) {
		clearInterval(selfDefenseIntervalId); // Detener el bucle de auto-defensa
		selfDefenseIntervalId = null;
		isBotDefendingItself = false; // Asegurarse de que el estado se reinicie
	}
	// Limpiar cola y comando actual si el bot muere
	if (currentCommand) {
		currentCommand = null;
	}
});

bot.on("playerLeft", (player) => {
	if (playerToDefend && player.username === playerToDefend.username) {
		bot.chat(`Parece que ${player.username} se ha ido. Dejaré de proteger.`);
		stopDefense(false);
	}
});
