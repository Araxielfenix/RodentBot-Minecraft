const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { OpenAI } = require("openai");
const { GoalBlock, GoalNear, GoalFollow } = goals;
const blockTranslations = require("./blockTranslations.js");
const fs = require("fs");
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
	host: process.env.SERVER_IP, // Dirección del servidor
	port: process.env.SERVER_PORT, // Puerto del servidor
	//host: "localhost",
	//port: 25565,
	username: "RodentBot",
	version: "1.21.1"
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
		if (staying) {
			bot.chat("¡Amenaza detectada! No puedo quedarme aquí!");
			staying = false; // Salir del modo "quedate"
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
	} else {
		// No hay hostil cercano en este tick.
		// No ponemos currentSelfDefenseTarget a null aquí.
		// Esto permite que si el mismo mob (identificado por currentSelfDefenseTarget.id)
		// reaparece, no se vuelva a anunciar la acción, porque announcedSelfDefenseActionForTarget seguirá siendo true.

		if (
			!followingPlayer &&
			!playerToDefend &&
			!staying &&
			bot.pathfinder.goal
		) {
			// console.log("[Self-Defense] No immediate threat, and not under other commands. Clearing pathfinder goal.");
			bot.pathfinder.setGoal(null);
			// bot.attack() debería dejar de intentar alcanzar un objetivo si el pathfinding se cancela
			// y el objetivo ya no es válido o está demasiado lejos según su propia lógica interna.
		}
	}
}

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
bot.on("chat", async (username, message) => {
	console.log(username + " dice: " + message);
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
			const player = bot.players[username];
			if (player && player.entity) {
				followingPlayer = player;
				bot.chat(`¡Te seguiré, ${username}!`);
				bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
			} else {
				bot.chat(`No puedo encontrarte para seguirte, ${username}.`);
			}
		} else if (command === "quedate") {
			staying = true;
			bot.chat("¡Me quedaré aquí!");
			bot.pathfinder.setGoal(null); // Detiene el movimiento
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
					bot.pathfinder.setGoal(new GoalBlock(x, y, z));
					bot.chat(`¡Voy a las coordenadas ${x}, ${y}, ${z}!`);
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
			} else {
				bot.chat(
					`Uso correcto: ${BOT_COMMAND_PREFIX}ve <x> <y> <z> o ${BOT_COMMAND_PREFIX}ve <jugador>`
				);
			}
		} else if (command === "aplana") {
			if (args.length === 1) {
				const size = parseInt(args[0]);
				if (isNaN(size) || size < 1 || size > 10) {
					bot.chat(
						`Indica un tamaño válido (1-10). Ejemplo: ${BOT_COMMAND_PREFIX}aplana 3`
					);
					return;
				}
				bot.chat(
					`¡Voy a aplanar un área de ${size}x${size} bloques alrededor mío!`
				);
				// Asegúrate de que el bot esté en el suelo o ajusta la lógica de 'y'
				const botY = Math.floor(bot.entity.position.y);
				for (let dy = -1; dy <= 0; dy++) {
					// Aplanar al nivel de los pies y un bloque arriba si es necesario
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
							const blockPos = bot.entity.position.offset(dx, dy, dz);
							const block = bot.blockAt(blockPos);
							if (block && block.name !== "air" && bot.canDigBlock(block)) {
								try {
									await bot.dig(block);
								} catch (err) {
									console.error(
										`Error al picar bloque en ${blockPos}:`,
										err.message
									);
								}
							}
						}
					}
				}
				bot.chat("¡Área aplanada!");
			} else {
				bot.chat(`Uso correcto: ${BOT_COMMAND_PREFIX}aplana <tamaño>`);
			}
		} else if (command === "consigue") {
			// Comando mejorado: ir, minar (con /give si es necesario) y regresar.
			if (args.length >= 1) {
				const userInputName = args.join(" ").toLowerCase(); // Permite nombres con espacios y convierte a minúsculas
				const englishName = blockTranslations[userInputName] || userInputName; // Usa traducción o el input original
				const blockType = bot.registry.blocksByName[englishName];

				if (!blockType) {
					bot.chat(`No reconozco el bloque "${userInputName}".`);
					return;
				}

				bot.chat(`Buscando ${userInputName} (como ${englishName})...`);
				const blocks = bot.findBlocks({
					matching: blockType.id,
					maxDistance: 64, // Radio de búsqueda más práctico
					count: 1, // Intentar conseguir un bloque a la vez
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

				const returnPosition = bot.entity.position.clone(); // Guardar posición para regresar

				try {
					// 1. Ir al bloque
					await bot.pathfinder.goto(
						new GoalNear(
							targetBlockPosition.x,
							targetBlockPosition.y,
							targetBlockPosition.z,
							1
						)
					); // Acercarse a 1 bloque de distancia
					bot.chat(`Llegué al bloque de ${userInputName}.`);

					// Refrescar la referencia al bloque por si el bot se movió ligeramente
					targetBlock = bot.blockAt(targetBlockPosition);
					if (!targetBlock || targetBlock.type !== blockType.id) {
						bot.chat(
							"El bloque objetivo cambió o desapareció al llegar. Abortando."
						);
						await bot.pathfinder.goto(
							new GoalNear(
								returnPosition.x,
								returnPosition.y,
								returnPosition.z,
								1
							)
						);
						bot.chat("He vuelto.");
						return;
					}

					// 2. Verificar herramienta y minar
					const creativeMode = bot.game.gameMode === "creative";
					let canDigNow = creativeMode || bot.canDigBlock(targetBlock);

					if (
						!canDigNow &&
						targetBlock.material &&
						bot.registry.materials[targetBlock.material]?.harvestTools
					) {
						bot.chat(
							`Necesito una herramienta para minar ${userInputName}. Buscando un pico...`
						);
						const pickaxeNames = [
							"diamond_pickaxe",
							"netherite_pickaxe",
							"iron_pickaxe",
							"stone_pickaxe",
							"wooden_pickaxe",
						];
						let equippedSuitablePickaxe = false;

						for (const pickName of pickaxeNames) {
							const pickaxeItem = itemByName(pickName); // Usa tu función itemByName
							if (pickaxeItem) {
								bot.chat(`Encontré ${pickName}. Intentando equipar...`);
								try {
									await bot.equip(pickaxeItem, "hand");
									bot.chat(`Equipé ${pickName}.`);
									if (bot.canDigBlock(targetBlock)) {
										// Re-verificar con el pico equipado
										canDigNow = true;
										equippedSuitablePickaxe = true;
										break;
									}
								} catch (equipErr) {
									bot.chat(`No pude equipar ${pickName}: ${equipErr.message}`);
								}
							}
						}

						if (!equippedSuitablePickaxe) {
							bot.chat("/give RodentBot minecraft:diamond_pickaxe");

							let attemptsToGetPickaxe = 0;
							const maxAttemptsToGetPickaxe = 3; // Intentará 3 veces
							const delayBetweenAttempts = 2000; // 2 segundos entre intentos

							while (
								attemptsToGetPickaxe < maxAttemptsToGetPickaxe &&
								!canDigNow
							) {
								attemptsToGetPickaxe++;
								bot.chat(
									`Intento ${attemptsToGetPickaxe}/${maxAttemptsToGetPickaxe} para encontrar y equipar el pico de diamante...`
								);
								await new Promise((resolve) =>
									setTimeout(resolve, delayBetweenAttempts)
								);

								const diamondPickaxe = itemByName("diamond_pickaxe");
								if (diamondPickaxe) {
									try {
										await bot.equip(diamondPickaxe, "hand");
										bot.chat("Pico de diamante equipado.");
										if (bot.canDigBlock(targetBlock)) {
											canDigNow = true; // Éxito, saldrá del bucle
										} else {
											bot.chat(
												"Equipé el pico de diamante, pero aún no puedo minar el bloque. Verificando..."
											);
										}
									} catch (equipErr) {
										bot.chat(
											`No pude equipar el pico de diamante: ${equipErr.message}`
										);
									}
								} else {
									bot.chat("Pico de diamante aún no encontrado en inventario.");
								}
							}

							if (!canDigNow) {
								bot.chat(
									"No pude obtener o equipar el pico de diamante después de /give e intentos."
								);
							}
						}
					}

					if (canDigNow) {
						bot.chat(`Minando ${userInputName}...`);
						await bot.dig(targetBlock);
						bot.chat(`¡Miné ${userInputName}!`);
					} else {
						bot.chat(
							`No puedo minar ${userInputName}. Puede que necesite una herramienta específica o no tenga permisos.`
						);
					}

					// 3. Regresar
					bot.chat("Regresando a la posición original...");
					await bot.pathfinder.goto(
						new GoalNear(
							returnPosition.x,
							returnPosition.y,
							returnPosition.z,
							1
						)
					);
					bot.chat("He vuelto.");
				} catch (err) {
					console.error("Error en el comando 'consigue':", err);
					bot.chat(
						`Ocurrió un error al intentar conseguir ${userInputName}: ${err.message}`
					);
					try {
						bot.chat(
							"Intentando regresar a la posición original después de un error..."
						);
						await bot.pathfinder.goto(
							new GoalNear(
								returnPosition.x,
								returnPosition.y,
								returnPosition.z,
								1
							)
						);
						bot.chat("He vuelto (después de error).");
					} catch (returnErr) {
						console.error(
							"Error al intentar regresar después de un error:",
							returnErr
						);
						bot.chat(
							"No pude regresar a la posición original después del error."
						);
					}
				}
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
			if (args.length >= 1) {
				const itemName = args[0].toLowerCase(); // Asegurar minúsculas para la traducción
				const amountStr = args[1];

				const player = bot.players[username];
				if (player && player.entity) {
					bot.chat(
						`¡Entendido, ${username}! Voy hacia ti para darte ${itemName}.`
					);
					try {
						await bot.pathfinder.goto(
							new GoalNear( // Usamos GoalNear para acercarnos al jugador
								player.entity.position.x,
								player.entity.position.y,
								player.entity.position.z,
								2 // Distancia en bloques a la que se acercará (ej. 2 bloques)
							)
						);
						bot.chat(`Llegué, ${username}. Aquí tienes tu ${itemName}.`);
						await tossItemCmd(itemName, amountStr);
					} catch (err) {
						console.error(
							`Error al ir hacia ${username} o tirar el ítem:`,
							err
						);
						bot.chat(
							`Tuve problemas para acercarme o tirar el ítem: ${err.message}. Lo soltaré aquí.`
						);
						await tossItemCmd(itemName, amountStr); // Intenta tirar el ítem en la posición actual como fallback
					}
				} else {
					bot.chat(`No te encuentro, ${username}. Dejaré ${itemName} aquí.`);
					await tossItemCmd(itemName, amountStr); // Si no encuentra al jugador, tira el ítem donde está
				}
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
				await equipItemCmd(itemName, destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}equipar <destino> <nombre_item>`);
			}
		} else if (command === "desequipar" || command === "unequip") {
			// Formato: !rodent desequipar <destino>
			// Ej: !rodent desequipar hand
			if (args.length === 1) {
				const destination = args[0].toLowerCase();
				await unequipItemCmd(destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}desequipar <destino>`);
			}
		} else if (command === "usar" || command === "use") {
			// Ahora puede aceptar un nombre de ítem
			// Formato: !rodent usar [nombre_item]
			// Ej: !rodent usar espada_diamante  O  !rodent usar (para usar lo que tenga en mano)
			const itemName = args[0]; // Puede ser undefined si solo se escribe "!rodent usar"
		} else if (command === "fabricar" || command === "craft") {
			// Formato: !rodent fabricar <nombre_item> [cantidad]
			// Ej: !rodent fabricar palo 4
			if (args.length >= 1) {
				const itemName = args[0];
				const amountStr = args[1]; // Puede ser undefined
				await craftItemCmd(itemName, amountStr);
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
	}
});

bot.on("playerLeft", (player) => {
	if (playerToDefend && player.username === playerToDefend.username) {
		bot.chat(`Parece que ${player.username} se ha ido. Dejaré de proteger.`);
		stopDefense(false);
	}
});
