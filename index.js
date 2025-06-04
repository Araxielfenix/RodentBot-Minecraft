const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { OpenAI } = require("openai");
const { GoalBlock, GoalNear, GoalFollow } = goals;
const Vec3 = require("vec3"); // Importar Vec3
const deathEvent = require("mineflayer-death-event"); // Importar el nuevo plugin
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
	host: process.env.SERVER_IP, // Dirección del servidor
	port: process.env.SERVER_PORT, // Puerto del servidor
	//host: "localhost",
	//port: 25565,
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
const HUNGER_THRESHOLD = 15; // Nivel de comida por debajo del cual el bot intentará comer
const AUTO_EAT_TICK_RATE = 5000; // Con qué frecuencia verificar si necesita comer (milisegundos)

// --- Variables para la Cola de Comandos ---
let commandQueue = [];
let currentCommand = null; // { name: string, func: async function, args: array, username: string }
let isBotDefendingItself = false; // true si el bot está activamente en modo de autodefensa
let isEating = false; // true si el bot está actualmente en proceso de comer
let autoEatIntervalId = null; // ID del intervalo para el bucle de auto-alimentación

// Error específico para interrupciones
const INTERRUPTED_FOR_DEFENSE_ERROR = "INTERRUPTED_FOR_DEFENSE";

// Función para verificar si la tarea actual debe ser interrumpida por autodefensa
const checkInterrupt = () => {
	if (isBotDefendingItself) throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
};

// --- Variables para Mensajes de Muerte con IA ---
let capturedDeathMessage = null; // Almacenará la razón de la muerte capturada
let isInitialSpawn = true; // Variable para rastrear si es el primer spawn

let currentSelfDefenseTarget = null; // Para rastrear el objetivo actual en auto-defensa
let announcedSelfDefenseActionForTarget = false; // Para saber si ya se anunció la acción para el objetivo actual

bot.on("spawn", async () => {
	console.log("Bot conectado, obteniendo versión...");
	console.log("Versión del bot:", bot.version);

	bot.loadPlugin(pathfinder);
	bot.loadPlugin(deathEvent);

	movements = new Movements(bot, bot.registry);
	bot.pathfinder.setMovements(movements);

	if (isInitialSpawn) {
		try {
			const greetingPrompt =
				"Acabas de conectarte al servidor de minecraft RodentPlay. Genera un saludo corto, ingenioso y divertido para anunciar tu llegada en el chat de minecraft.";
			const aiGreeting = await getShapeResponse(greetingPrompt);
			bot.chat(aiGreeting);
		} catch (e) {
			console.error("Error obteniendo el saludo de la IA:", e);
			bot.chat(
				"RodentBot reportándose para la aventura. (Mi IA del saludo tuvo un pequeño hipo)."
			);
		} finally {
			isInitialSpawn = false;
		}
	} else {
		if (capturedDeathMessage) {
			try {
				const respawnPrompt = `Acabas de morir en minecraft. La última vez, esto fue lo que pasó (o lo que creo que pasó): "${capturedDeathMessage}". Escribe un mensaje corto, ingenioso o divertido acerca de tu muerte`;
				const aiRespawnMessage = await getShapeResponse(respawnPrompt);
				bot.chat(aiRespawnMessage);
			} catch (e) {
				console.error("Error obteniendo el mensaje de respawn de la IA:", e);
				bot.chat(
					`¡He vuelto! Aunque mi IA está un poco confundida sobre cómo pasó esto: "${capturedDeathMessage}"`
				);
			}
			capturedDeathMessage = null;
		} else {
			bot.chat(
				"¡He vuelto! No estoy seguro de qué pasó, pero aquí estoy de nuevo."
			);
		}
	}

	if (selfDefenseIntervalId) clearInterval(selfDefenseIntervalId);
	console.log("Iniciando bucle de auto-defensa...");
	selfDefenseIntervalId = setInterval(selfDefenseLoop, SELF_DEFENSE_TICK_RATE);

	if (autoEatIntervalId) clearInterval(autoEatIntervalId);
	autoEatIntervalId = setInterval(autoEatLoop, AUTO_EAT_TICK_RATE);
});

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

function stopDefense(informPlayer = true) {
	if (defenseIntervalId) {
		clearInterval(defenseIntervalId);
		defenseIntervalId = null;
	}
	playerToDefend = null;
}

function findBestSword() {
	const swordNames = [
		"diamond_sword",
		"netherite_sword",
		"iron_sword",
		"stone_sword",
		"golden_sword",
		"wooden_sword",
	];
	for (const swordName of swordNames) {
		const sword = itemByName(swordName);
		if (sword) return sword;
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
	const giveCommandUser = bot.username;

	for (const slot in armorSlots) {
		const pieceType = armorSlots[slot];
		let bestPieceForSlot = null;
		let currentBestTierIndex = armorTiers.length;

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

		for (let i = 0; i < currentBestTierIndex; i++) {
			const tier = armorTiers[i];
			const fullItemName = `${tier}_${pieceType}`;
			const itemInInventory = itemByName(fullItemName);
			if (itemInInventory) {
				bestPieceForSlot = itemInInventory;
				currentBestTierIndex = i;
				break;
			}
		}

		const diamondTierIndex = armorTiers.indexOf("diamond");
		if (
			currentBestTierIndex > diamondTierIndex &&
			bot.game.gameMode !== "creative"
		) {
			const diamondPieceName = `diamond_${pieceType}`;
			let hasDiamondOrBetter = false;
			if (bestPieceForSlot) {
				const tierOfBestPiece = bestPieceForSlot.name.split("_")[0];
				if (armorTiers.indexOf(tierOfBestPiece) <= diamondTierIndex) {
					hasDiamondOrBetter = true;
				}
			}
			if (!hasDiamondOrBetter) {
				bot.chat(`/give ${giveCommandUser} minecraft:${diamondPieceName}`);
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const newItem = itemByName(diamondPieceName);
				if (newItem) {
					bestPieceForSlot = newItem;
				} else {
					console.log(`No pude obtener ${diamondPieceName} con /give.`);
				}
			}
		}

		if (
			bestPieceForSlot &&
			(!equippedItem || equippedItem.type !== bestPieceForSlot.type)
		) {
			try {
				await bot.equip(bestPieceForSlot, slot);
			} catch (err) {
				bot.chat(
					`Error al equipar ${bestPieceForSlot.displayName} en ${slot}: ${err.message}`
				);
				console.error(
					`Error equipando ${bestPieceForSlot.name} en ${slot}:`,
					err
				);
			}
		}
	}

	let bestSword = null;
	let currentBestSwordTierIndex = weaponTiers.length;
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

	for (let i = 0; i < currentBestSwordTierIndex; i++) {
		const swordName = weaponTiers[i];
		const itemInInventory = itemByName(swordName);
		if (itemInInventory) {
			bestSword = itemInInventory;
			currentBestSwordTierIndex = i;
			break;
		}
	}

	const diamondSwordTierIndex = weaponTiers.indexOf("diamond_sword");
	if (
		currentBestSwordTierIndex > diamondSwordTierIndex &&
		bot.game.gameMode !== "creative"
	) {
		let hasDiamondOrBetterSword = false;
		if (bestSword) {
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
			} else {
				console.log(`No pude obtener diamond_sword con /give.`);
			}
		}
	}

	if (bestSword && (!currentWeapon || currentWeapon.type !== bestSword.type)) {
		try {
			await bot.equip(bestSword, "hand");
		} catch (err) {
			bot.chat(`Error al equipar ${bestSword.displayName}: ${err.message}`);
			console.error(`Error equipando ${bestSword.name}:`, err);
		}
	}
}

async function selfDefenseLoop() {
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
			isBotDefendingItself = true;
			if (currentCommand) {
				bot.chat(
					`¡Autodefensa activada! Pausando comando actual: ${currentCommand.name}.`
				);
				bot.pathfinder.stop();
			}
		}
		if (staying) staying = false;
		await ensureBestGear(true);

		if (
			currentSelfDefenseTarget === null ||
			currentSelfDefenseTarget.id !== nearestHostileToBot.id ||
			!announcedSelfDefenseActionForTarget
		) {
			currentSelfDefenseTarget = nearestHostileToBot;
			announcedSelfDefenseActionForTarget = false;
		}

		const bestSword = findBestSword();
		if (bestSword) {
			if (!announcedSelfDefenseActionForTarget) {
				announcedSelfDefenseActionForTarget = true;
				try {
					await bot.equip(bestSword, "hand");
				} catch (err) {
					console.error("Error al equipar espada en auto-defensa:", err);
					bot.chat("Tuve problemas para equipar mi espada.");
				}
			}
			bot.pathfinder.setGoal(new GoalFollow(nearestHostileToBot, 1.5), true);
			bot.attack(nearestHostileToBot, true);
		} else {
			if (!announcedSelfDefenseActionForTarget) {
				bot.chat(
					`¡${
						nearestHostileToBot.name || nearestHostileToBot.displayName
					} demasiado cerca! Huyendo...`
				);
				announcedSelfDefenseActionForTarget = true;
				const fleeVector = bot.entity.position
					.minus(nearestHostileToBot.position)
					.normalize()
					.scale(FLEE_DISTANCE);
				const fleePosition = bot.entity.position.plus(fleeVector);
				bot.pathfinder.setGoal(
					new GoalNear(fleePosition.x, fleePosition.y, fleePosition.z, 1),
					true
				);
			}
		}
	} else if (isBotDefendingItself) {
		isBotDefendingItself = false;
		currentSelfDefenseTarget = null;
		announcedSelfDefenseActionForTarget = false;
		if (bot.pathfinder.isMoving()) bot.pathfinder.stop();
		bot.pathfinder.setGoal(null);
		if (typeof bot.stopAttacking === "function") {
			bot.stopAttacking();
		} else {
			console.error("ERROR: bot.stopAttacking no es una función.");
		}
		runNextCommandFromQueue();
	}
}

function findFoodInInventory() {
	const items = bot.inventory.items();
	for (const item of items) {
		if (item.foodPoints && item.foodPoints > 0) return item;
	}
	return null;
}

async function autoEatLoop() {
	if (
		isEating ||
		!bot.food ||
		bot.food >= HUNGER_THRESHOLD ||
		isBotDefendingItself
	) {
		return;
	}
	isEating = true;
	try {
		let foodItem = findFoodInInventory();
		if (!foodItem && bot.game.gameMode !== "creative") {
			bot.chat(`/give ${bot.username} minecraft:bread 1`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			foodItem = itemByName("bread");
		}
		if (foodItem) {
			try {
				const currentHeldItem = bot.heldItem;
				await bot.equip(foodItem, "hand");
				await bot.consume();
				if (currentHeldItem && currentHeldItem.type !== foodItem.type) {
					await bot.equip(currentHeldItem, "hand");
				}
			} catch (error) {
				// Silently fail for now, or log to console if preferred
			}
		}
	} catch (error) {
		// Silently fail for now, or log to console if preferred
	} finally {
		isEating = false;
	}
}

async function runCommand(commandObj) {
	currentCommand = commandObj;
	bot.chat(`A la orden ${commandObj.username}`);
	try {
		await commandObj.func(...commandObj.args, commandObj.username);
		bot.chat(`Misión '${commandObj.name}' completada.`);
	} catch (err) {
		if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR) {
			bot.chat(`Comando '${commandObj.name}' pausado debido a la autodefensa.`);
			if (currentCommand) {
				commandQueue.unshift(currentCommand);
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
			runNextCommandFromQueue();
		}
	}
}

function runNextCommandFromQueue() {
	if (currentCommand || isBotDefendingItself || staying) return;
	if (commandQueue.length > 0) {
		const nextCommand = commandQueue.shift();
		runCommand(nextCommand);
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

function itemToString(item) {
	return item ? `${item.name} x ${item.count}` : "(nada)";
}

function itemByName(name) {
	const translatedName =
		blockTranslations[name.toLowerCase()] || name.toLowerCase();
	const items = bot.inventory.items();
	if (bot.registry.isNewerOrEqualTo("1.9") && bot.inventory.slots[45]) {
		items.push(bot.inventory.slots[45]);
	}
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
		items.push(bot.inventory.slots[45]);
	}
	const output = items.map(itemToString).join(", ");
	bot.chat(output ? "Inventario: " + output : "Inventario vacío.");
}

async function tossItemCmd(itemName, amountStr) {
	const amount = amountStr ? parseInt(amountStr, 10) : null;
	const item = itemByName(itemName);
	if (!item) return;
	try {
		if (amount) {
			await bot.toss(item.type, null, amount);
			bot.chat(`Tiré ${amount} x ${itemName}.`);
		} else {
			await bot.tossStack(item);
			bot.chat(`Tiré ${item.count} x ${itemName}.`);
		}
	} catch (err) {
		bot.chat(`No pude tirar el ítem: ${err.message}`);
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
		bot.activateItem();
		return;
	}
	const item = itemByName(itemName);
	if (item) {
		try {
			bot.chat(`Intentando equipar y usar ${itemName}...`);
			await bot.equip(item, "hand");
			bot.chat(`Equipé ${itemName} en la mano.`);
			bot.activateItem();
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
		maxDistance: 4,
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

async function executeConsigueCommand(
	userInputName,
	quantityArg,
	usernameForContext
) {
	async function ensureToolForBlock(
		targetBlockToMine,
		itemNameForChat,
		requiredToolType = null
	) {
		const toolsToCheck = [];
		if (requiredToolType === "pickaxe") {
			toolsToCheck.push({
				name: "diamond_pickaxe",
				giveCmd: `minecraft:diamond_pickaxe`,
				type: "pico",
			});
		} else if (requiredToolType === "axe") {
			toolsToCheck.push({
				name: "diamond_axe",
				giveCmd: `minecraft:diamond_axe`,
				type: "hacha",
			});
		} else if (targetBlockToMine) {
			const materialName = targetBlockToMine.name.toLowerCase();
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
				toolsToCheck.push({
					name: "diamond_axe",
					giveCmd: `minecraft:diamond_axe`,
					type: "hacha",
				});
			} else {
				const blockMaterialInfo = targetBlockToMine.material
					? bot.registry.materials[targetBlockToMine.material]
					: null;
				const requiresTool =
					blockMaterialInfo &&
					blockMaterialInfo.harvestTools &&
					Object.keys(blockMaterialInfo.harvestTools).length > 0;
				if (requiresTool) {
					toolsToCheck.push({
						name: "diamond_pickaxe",
						giveCmd: `minecraft:diamond_pickaxe`,
						type: "pico",
					});
				} else {
					return true;
				}
			}
		} else {
			console.error(
				"ensureToolForBlock llamada con targetBlockToMine=null y requiredToolType=null."
			);
			return false;
		}

		for (const toolDetail of toolsToCheck) {
			let tool = itemByName(toolDetail.name);
			if (!tool) {
				bot.chat(`/give ${bot.username} ${toolDetail.giveCmd}`);
				await new Promise((resolve) => setTimeout(resolve, 2000));
				checkInterrupt();
				tool = itemByName(toolDetail.name);
			}
			if (tool) {
				await bot.equip(tool, "hand");
				checkInterrupt();
				if (!targetBlockToMine || bot.canDigBlock(targetBlockToMine)) {
					if (!targetBlockToMine)
						bot.chat(`${toolDetail.type} de diamante equipado.`);
					return true;
				} else if (targetBlockToMine) {
					bot.chat(
						`${toolDetail.type} de diamante equipado, pero no es el adecuado para ${itemNameForChat} o no es suficiente.`
					);
				}
			} else {
				bot.chat(
					`No pude encontrar u obtener ${toolDetail.type} de diamante (${toolDetail.name}) después del intento de /give.`
				);
			}
		}
		bot.chat(
			targetBlockToMine
				? `No se pudo equipar una herramienta adecuada para ${itemNameForChat}.`
				: `No se pudo equipar una herramienta de diamante adecuada.`
		);
		return false;
	}

	bot.chat(
		`Asegurando pico de diamante para la tarea de conseguir ${userInputName}...`
	);
	const hasRequiredToolEquipped = await ensureToolForBlock(
		null,
		"minar",
		"pickaxe"
	);
	if (!hasRequiredToolEquipped && bot.game.gameMode !== "creative") {
		bot.chat(
			`No pude asegurar un pico de diamante. No puedo minar ${userInputName}.`
		);
		return;
	}

	const englishName =
		blockTranslations[userInputName.toLowerCase()] ||
		userInputName.toLowerCase();
	const blockType = bot.registry.blocksByName[englishName];
	if (!blockType) {
		bot.chat(`No reconozco el bloque "${userInputName}".`);
		return;
	}

	let desiredQuantity;
	let isSpecificQuantityRequested = false;
	let blocksToProcess = [];
	const returnPosition = bot.entity.position.clone();
	const MAX_SEARCH_DISTANCE = 64;
	let collectedAmount = 0;

	try {
		if (quantityArg) {
			const parsedQuantity = parseInt(quantityArg, 10);
			if (!isNaN(parsedQuantity) && parsedQuantity > 0) {
				desiredQuantity = parsedQuantity;
				isSpecificQuantityRequested = true;
				bot.chat(`Objetivo: conseguir ${desiredQuantity} de ${userInputName}.`);
			} else {
				bot.chat(
					`Cantidad "${quantityArg}" no válida. Buscaré los cercanos en una tanda.`
				);
				desiredQuantity = 0;
				isSpecificQuantityRequested = false;
			}
		} else {
			bot.chat(`Buscando ${userInputName} cercanos para minar (una tanda)...`);
			desiredQuantity = 0;
			isSpecificQuantityRequested = false;
		}

		while (true) {
			checkInterrupt();
			if (isSpecificQuantityRequested) {
				if (collectedAmount >= desiredQuantity) break;
				const remainingNeededSearch = Math.max(
					1,
					Math.min(desiredQuantity - collectedAmount, 20)
				);
				blocksToProcess = bot.findBlocks({
					matching: blockType.id,
					maxDistance: MAX_SEARCH_DISTANCE,
					count: remainingNeededSearch,
				});
				if (blocksToProcess.length === 0) {
					bot.chat(
						collectedAmount > 0
							? `No encontré más ${userInputName}. Total recolectado: ${collectedAmount}.`
							: `No encontré ${userInputName} para recolectar.`
					);
					break;
				}
				bot.chat(
					`Esperame aqui, volere con ${blocksToProcess.length} bloque(s) de ${userInputName}...`
				);
			} else {
				if (collectedAmount > 0) break;
				const initialSearchCount = 20;
				blocksToProcess = bot.findBlocks({
					matching: blockType.id,
					maxDistance: MAX_SEARCH_DISTANCE,
					count: initialSearchCount,
				});
				if (blocksToProcess.length === 0) {
					bot.chat(`No encontré bloques de ${userInputName} cerca.`);
					break;
				}
				desiredQuantity = blocksToProcess.length;
				bot.chat(
					`Esperame aqui, volere con ${blocksToProcess.length} bloque(s) de ${userInputName}...`
				);
				if (desiredQuantity === 0) break;
			}

			for (const targetBlockPosition of blocksToProcess) {
				if (
					(isSpecificQuantityRequested && collectedAmount >= desiredQuantity) ||
					(!isSpecificQuantityRequested && collectedAmount >= desiredQuantity)
				)
					break;
				checkInterrupt();
				let currentBlockEntity = bot.blockAt(targetBlockPosition);
				if (!currentBlockEntity || currentBlockEntity.type !== blockType.id) {
					bot.chat(
						`Bloque en ${targetBlockPosition} ya no es ${userInputName} o no existe. Saltando.`
					);
					continue;
				}
				try {
					await bot.pathfinder.goto(
						new GoalNear(
							targetBlockPosition.x,
							targetBlockPosition.y,
							targetBlockPosition.z,
							1
						)
					);
				} catch (pathError) {
					if (
						pathError.message.toLowerCase().includes("goal interrupted") ||
						pathError.message
							.toLowerCase()
							.includes("pathfinding interrupted") ||
						pathError.message.toLowerCase().includes("goalchanged")
					) {
						if (isBotDefendingItself)
							throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
						bot.chat(
							`Movimiento a ${userInputName} interrumpido (no por defensa). Saltando este bloque.`
						);
						continue;
					}
					console.error(
						`Error de pathfinding no manejado a ${targetBlockPosition}:`,
						pathError
					);
					continue;
				}
				checkInterrupt();
				currentBlockEntity = bot.blockAt(targetBlockPosition);
				if (!currentBlockEntity || currentBlockEntity.type !== blockType.id) {
					bot.chat(
						`Bloque en ${targetBlockPosition} cambió tras llegar. Saltando.`
					);
					continue;
				}

				const creativeMode = bot.game.gameMode === "creative";
				let canDigNow = creativeMode
					? true
					: await ensureToolForBlock(currentBlockEntity, userInputName);

				if (!canDigNow && !creativeMode) {
					bot.chat(
						`No puedo minar ${userInputName} en ${currentBlockEntity.position}. Saltando.`
					);
				}

				if (canDigNow) {
					checkInterrupt();
					try {
						await bot.dig(currentBlockEntity);
						await new Promise((resolve) => setTimeout(resolve, 1500));
						checkInterrupt();
						if (
							bot.heldItem === null &&
							hasRequiredToolEquipped &&
							!creativeMode
						) {
							bot.chat("¡Mi herramienta se rompió!");
						}
						collectedAmount++;
						let progressMessage = `¡Miné ${userInputName}! Total recolectado: ${collectedAmount}`;
						if (
							isSpecificQuantityRequested ||
							(!isSpecificQuantityRequested && desiredQuantity > 0)
						) {
							progressMessage += `/${desiredQuantity}`;
						}
						bot.chat(progressMessage + ".");
					} catch (digError) {
						if (digError.message.toLowerCase().includes("dig interrupted")) {
							if (isBotDefendingItself)
								throw new Error(INTERRUPTED_FOR_DEFENSE_ERROR);
							bot.chat(
								`Minado de ${userInputName} interrumpido (no por defensa). Saltando.`
							);
							continue;
						}
						console.error(
							`Error al minar ${currentBlockEntity.name} en ${currentBlockEntity.position}:`,
							digError
						);
						bot.chat(
							`Error al minar ${userInputName}: ${digError.message}. Saltando.`
						);
						continue;
					}
				} else {
					bot.chat(
						`No puedo minar ${userInputName} en ${currentBlockEntity.position}. Saltando.`
					);
					continue;
				}
			}
			if (!isSpecificQuantityRequested) break;
		}
		bot.chat(
			`Tarea de conseguir ${userInputName} finalizada. Total recolectado: ${collectedAmount}.`
		);
	} catch (err) {
		if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR) {
			bot.chat(
				`Tarea 'consigue ${userInputName}' pausada por autodefensa. Recolectado: ${collectedAmount}.`
			);
			throw err;
		}
		if (
			isBotDefendingItself &&
			(err.message.toLowerCase().includes("pathfinding interrupted") ||
				err.message.toLowerCase().includes("goal interrupted") ||
				err.message.toLowerCase().includes("goalchanged") ||
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
			`Ocurrió un error al intentar conseguir ${userInputName}: ${err.message}. Recolectado: ${collectedAmount}.`
		);
	} finally {
		bot.chat("Regresando a la posición original...");
		try {
			await bot.pathfinder.goto(
				new GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1)
			);
			bot.chat("He vuelto.");
		} catch (returnErr) {
			console.error(
				"Error al intentar regresar después de 'consigue':",
				returnErr
			);
			bot.chat(
				"No pude regresar a la posición original después de la tarea de conseguir."
			);
		}
	}
}

bot.on("chat", async (username, message) => {
	if (username === bot.username) return;
	const msgLower = message.toLowerCase();

	if (msgLower.startsWith(BOT_COMMAND_PREFIX)) {
		console.log("Bot Command recibido de " + username + ": " + message);
		const commandString = msgLower.substring(BOT_COMMAND_PREFIX.length).trim();
		const args = commandString.split(" ");
		const command = args.shift()?.toLowerCase();

		if (command === "sigueme") {
			if (currentCommand) {
				bot.pathfinder.stop();
				bot.chat(`Comando '${currentCommand.name}' cancelado para seguirte.`);
				currentCommand = null;
			}
			commandQueue = [];
			staying = false;
			isBotDefendingItself = false;
			const player = bot.players[username];
			if (player && player.entity) {
				followingPlayer = player;
				bot.chat(`¡Te seguiré, ${username}!`);
				bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
				stopDefense(false);
			} else {
				bot.chat(`No puedo encontrarte para seguirte, ${username}.`);
			}
		} else if (command === "quedate") {
			staying = true;
			bot.chat("¡Me quedaré aquí!");
			bot.pathfinder.setGoal(null);
			if (currentCommand) {
				bot.chat(
					`Comando '${currentCommand.name}' cancelado para quedarme quieto.`
				);
				currentCommand = null;
			}
			commandQueue = [];
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
				bot.chat(`¡Voy hacia ti, ${username}!`);
			} else {
				bot.chat("No puedo ir hacia ti porque no te encuentro.");
			}
		} else if (command === "ve") {
			if (args.length === 3) {
				const x = parseInt(args[0]);
				const y = parseInt(args[1]);
				const z = parseInt(args[2]);
				if (isNaN(x) || isNaN(y) || isNaN(z)) {
					bot.chat("Las coordenadas no son válidas.");
				} else {
					addCommandToQueue(
						"ve_coords",
						async (x_coord, y_coord, z_coord) => {
							bot.pathfinder.setGoal(new GoalBlock(x_coord, y_coord, z_coord));
							bot.chat(
								`¡Voy a las coordenadas ${x_coord}, ${y_coord}, ${z_coord}!`
							);
						},
						[x, y, z],
						username
					);
				}
			} else if (args.length === 1) {
				const targetPlayerName = args[0];
				const player = bot.players[targetPlayerName];
				if (player && player.entity) {
					bot.pathfinder.setGoal(
						new GoalNear(
							player.entity.position.x,
							player.entity.position.y,
							player.entity.position.z,
							1
						)
					);
					bot.chat(`¡Voy hacia ${targetPlayerName}!`);
				} else {
					bot.chat(`No encuentro al jugador ${targetPlayerName}.`);
				}
			} else if (args.length === 0 && followingPlayer) {
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
			async function executeAplanaCommand(
				length,
				width,
				heightArg,
				usernameForContext
			) {
				let yOffsetsToClear = [];
				let heightDescription = "";

				if (heightArg === undefined) {
					yOffsetsToClear = [0, -1];
					heightDescription = "2 niveles (pies y debajo)";
				} else {
					const heightVal = parseInt(heightArg);
					if (heightVal > 0) {
						for (let y = 0; y < heightVal; y++) yOffsetsToClear.push(y);
						heightDescription = `${heightVal} nivel(es) hacia arriba (desde los pies)`;
					} else if (heightVal < 0) {
						for (let y = 0; y >= heightVal; y--) yOffsetsToClear.push(y);
						heightDescription = `${
							Math.abs(heightVal) + 1
						} nivel(es) hacia abajo (desde los pies)`;
					} else {
						yOffsetsToClear.push(0);
						heightDescription = "solo el nivel de los pies";
					}
				}
				const initialBotPosition = bot.entity.position.clone();
				const targetCentralX = Math.floor(initialBotPosition.x); // X central del área de aplanado
				const targetCentralZ = Math.floor(initialBotPosition.z); // Z central del área de aplanado

				bot.chat(
					`¡Voy a aplanar un área de ${length}x${width} bloques, altura: ${heightDescription}!`
				);

				const minDx = -Math.floor(length / 2);
				const maxDx = Math.floor((length - 1) / 2);
				const minDz = -Math.floor(width / 2);
				const maxDz = Math.floor((width - 1) / 2);

				for (const yOffset of yOffsetsToClear) {
					for (let dx = minDx; dx <= maxDx; dx++) {
						for (let dz = minDz; dz <= maxDz; dz++) {
							checkInterrupt();
							const blockPos = initialBotPosition
								.offset(dx, yOffset, dz)
								.floored();
							const block = bot.blockAt(blockPos);

							if (dx === 0 && dz === 0 && yOffset === 0) {
								continue;
							}

							if (block && block.name !== "air") {
								let idealToolName = null;
								const blockMaterial =
									block.material && bot.registry.materials[block.material]
										? bot.registry.materials[block.material].name
										: null;
								const blockName = block.name.toLowerCase();

								const axeMaterials = [
									"wood",
									"leaves",
									"plant",
									"pumpkin",
									"web",
									"wool",
									"banner",
									"coral",
									"hay_block",
									"honey_block",
									"slime_block",
									"scaffolding",
								];
								const shovelMaterials = [
									"dirt",
									"sand",
									"grass",
									"gravel",
									"clay",
									"snow",
									"mycelium",
									"farmland",
									"path",
									"podzol",
									"soul_sand",
									"soul_soil",
									"concrete_powder",
								];
								const pickaxeMaterials = [
									"rock",
									"stone",
									"metal",
									"anvil",
									"ice",
									"piston",
									"brick",
									"netherrack",
									"end_stone",
									"obsidian",
									"furnace",
									"dispenser",
									"dropper",
									"concrete",
									"terracotta",
									"shulker_box",
									"chest",
									"ender_chest",
									"beacon",
									"enchanting_table",
									"brewing_stand",
									"hopper",
								];

								if (
									blockMaterial &&
									axeMaterials.some((matKeyword) =>
										blockMaterial.includes(matKeyword)
									)
								) {
									idealToolName = "diamond_axe";
								} else if (
									blockMaterial &&
									shovelMaterials.some((matKeyword) =>
										blockMaterial.includes(matKeyword)
									)
								) {
									idealToolName = "diamond_shovel";
								} else if (
									blockName.includes("ore") ||
									(blockMaterial &&
										pickaxeMaterials.some((matKeyword) =>
											blockMaterial.includes(matKeyword)
										))
								) {
									idealToolName = "diamond_pickaxe";
								} else {
									if (
										blockName.includes("log") ||
										blockName.includes("planks") ||
										blockName.includes("wood")
									)
										idealToolName = "diamond_axe";
									else if (
										blockName.includes("dirt") ||
										blockName.includes("sand") ||
										blockName.includes("gravel") ||
										blockName.includes("grass")
									)
										idealToolName = "diamond_shovel";
									else if (
										blockName.includes("stone") ||
										blockName.includes("cobble") ||
										blockName.includes("brick") ||
										blockName.includes("netherrack") ||
										blockName.includes("obsidian")
									)
										idealToolName = "diamond_pickaxe";
								}

								let canDigThisBlock = false;
								const creativeMode = bot.game.gameMode === "creative";

								if (creativeMode) {
									canDigThisBlock = true;
								} else if (idealToolName) {
									let toolItem = itemByName(idealToolName);
									if (!bot.heldItem || bot.heldItem.name !== idealToolName) {
										if (!toolItem) {
											bot.chat(
												`/give ${bot.username} minecraft:${idealToolName}`
											);
											await new Promise((resolve) => setTimeout(resolve, 1000));
											checkInterrupt();
											toolItem = itemByName(idealToolName);
										}
										if (toolItem) {
											await bot.equip(toolItem, "hand");
											checkInterrupt();
										}
									}
									if (
										bot.heldItem &&
										bot.heldItem.name === idealToolName &&
										bot.canDigBlock(block)
									) {
										canDigThisBlock = true;
									}
								} else {
									if (bot.canDigBlock(block)) canDigThisBlock = true;
								}

								if (canDigThisBlock) {
									const botFeet = bot.entity.position.floored();
									const supportUnderBot = botFeet.offset(0, -1, 0);
									let wasOwnSupport = blockPos.equals(supportUnderBot); // ¿Es el bloque a minar nuestro soporte actual?

									if (blockPos.equals(supportUnderBot)) {
										if (length > 1 || width > 1) {
											const sideOffsets = [
												{ x: 1, z: 0 },
												{ x: -1, z: 0 },
												{ x: 0, z: 1 },
												{ x: 0, z: -1 },
											];
											for (const off of sideOffsets) {
												const candidateStandPos = botFeet.offset(
													off.x,
													0,
													off.z
												);
												const candidateSupportPos = candidateStandPos.offset(
													0,
													-1,
													0
												);
												if (
													bot.blockAt(candidateStandPos)?.name === "air" &&
													bot.blockAt(candidateSupportPos)?.name !== "air" &&
													!candidateSupportPos.equals(blockPos)
												) {
													try {
														await bot.pathfinder.goto(
															new goals.GoalBlock(
																candidateStandPos.x,
																candidateStandPos.y,
																candidateStandPos.z
															)
														);
														break;
													} catch (e) {
														/* No se pudo mover */
													}
												}
											}
										}
									} else if (
										bot.entity.position.distanceTo(
											blockPos.offset(0.5, 0.5, 0.5)
										) > 4.5
									) {
										try {
											await bot.pathfinder.goto(
												new goals.GoalNear(
													blockPos.x,
													blockPos.y,
													blockPos.z,
													2.5
												)
											);
										} catch (e) {
											continue;
										}
									}
									try {
										await bot.dig(block);
										await new Promise((resolve) => setTimeout(resolve, 50));
										checkInterrupt();

										if (wasOwnSupport) {
											// Si acabamos de minar nuestro propio soporte, es probable que hayamos caído.
											// Intentar volver a la columna X,Z central del área de aplanado, en nuestra Y actual.
											const currentBotFlooredPos =
												bot.entity.position.floored();
											const currentBotY = currentBotFlooredPos.y;
											const currentBotX = currentBotFlooredPos.x;
											const currentBotZ = currentBotFlooredPos.z;

											const targetCenterColumnPos = new Vec3(
												targetCentralX,
												currentBotY,
												targetCentralZ
											);
											const supportAtCenterColumn = bot.blockAt(
												targetCenterColumnPos.offset(0, -1, 0)
											);

											// Si no estamos ya en la columna central (X,Z) Y hay soporte allí
											if (
												(currentBotX !== targetCentralX ||
													currentBotZ !== targetCentralZ) &&
												supportAtCenterColumn &&
												supportAtCenterColumn.name !== "air"
											) {
												try {
													// bot.chat("Volviendo al centro de la columna..."); // Para depuración
													await bot.pathfinder.goto(
														new goals.GoalBlock(
															targetCenterColumnPos.x,
															targetCenterColumnPos.y,
															targetCenterColumnPos.z
														)
													);
												} catch (e) {
													// bot.chat("No pude volver al centro de la columna."); // Para depuración
												}
											}
										}
									} catch (err) {
										if (err.message === INTERRUPTED_FOR_DEFENSE_ERROR)
											throw err;
									}
								} // fin de if (canDigThisBlock)
							}
						}
					}
				}
				bot.chat("¡Área aplanada!");
			}

			if (args.length >= 2 && args.length <= 3) {
				const length = parseInt(args[0]);
				const width = parseInt(args[1]);
				let heightArg = args[2] !== undefined ? parseInt(args[2]) : undefined;
				if (
					isNaN(length) ||
					length < 1 ||
					length > 10 ||
					isNaN(width) ||
					width < 1 ||
					width > 10
				) {
					bot.chat(
						`Largo y ancho deben ser números entre 1 y 10. Ejemplo: ${BOT_COMMAND_PREFIX}aplana 5 5`
					);
					return;
				}
				if (heightArg !== undefined) {
					if (isNaN(heightArg) || heightArg < -5 || heightArg > 5) {
						bot.chat(
							`Altura opcional debe ser un número entre -5 y 5. Ejemplo: ${BOT_COMMAND_PREFIX}aplana 5 5 2`
						);
						return;
					}
				}
				addCommandToQueue(
					"aplana",
					executeAplanaCommand,
					[length, width, heightArg],
					username
				);
			} else {
				bot.chat(
					`Uso correcto: ${BOT_COMMAND_PREFIX}aplana <largo> <ancho> [alto_opcional]\n` +
						`Largo/Ancho: 1-10. Alto: -5 a 5.\n` +
						`Si no se da alto, se aplanan 2 niveles (pies y debajo).\n` +
						`Si alto=N (>0): ${"`N`"} niveles hacia arriba desde los pies.\n` +
						`Si alto=N (<0): ${"`|N|+1`"} niveles hacia abajo desde los pies.\n` +
						`Si alto=0: solo nivel de los pies.`
				);
			}
		} else if (command === "consigue") {
			if (args.length === 0) {
				bot.chat(
					`Uso correcto: ${BOT_COMMAND_PREFIX}consigue <nombre_bloque> [cantidad]`
				);
				return;
			}
			let itemName;
			let quantityArg = null;
			const lastArg = args[args.length - 1];
			if (args.length > 1 && !isNaN(parseInt(lastArg))) {
				quantityArg = lastArg;
				itemName = args.slice(0, -1).join(" ").toLowerCase();
			} else {
				itemName = args.join(" ").toLowerCase();
			}
			addCommandToQueue(
				"consigue",
				executeConsigueCommand,
				[itemName, quantityArg],
				username
			);
		} else if (command === "protegeme") {
			const player = bot.players[username];
			if (!player || !player.entity) {
				bot.chat(`No te encuentro, ${username}.`);
				return;
			}
			if (staying) {
				staying = false;
				bot.chat("Dejaré de estar quieto para poder protegerte mejor.");
			}
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
			stopDefense(false);
			playerToDefend = player;
			console.log(`[Defensa] Iniciando defensa para ${username}.`);
			bot.chat(
				`¡Entendido, ${username}! Te protegeré de los monstruos cercanos.`
			);
			defenseIntervalId = setInterval(async () => {
				if (
					!playerToDefend ||
					!playerToDefend.entity ||
					playerToDefend.entity.health === 0 ||
					!bot.players[playerToDefend.username]
				) {
					if (playerToDefend)
						bot.chat(
							`Dejando de proteger a ${playerToDefend.username} (ya no está disponible o ha muerto).`
						);
					stopDefense(false);
					return;
				}
				let nearestHostile = null;
				let minDistanceSq = DEFENSE_RADIUS * DEFENSE_RADIUS;
				const commonHostilesString = process.env.COMMON_HOSTILES || "";
				const commonHostiles = commonHostilesString
					.split(",")
					.map((mob) => mob.trim().toLowerCase())
					.filter((mob) => mob.length > 0);

				for (const entityId in bot.entities) {
					const entity = bot.entities[entityId];
					if (
						!entity ||
						entity === bot.entity ||
						entity === playerToDefend.entity
					)
						continue;
					const entityNameLower = entity.name
						? entity.name.toLowerCase()
						: null;
					if (entityNameLower && commonHostiles.includes(entityNameLower)) {
						const distanceSq = playerToDefend.entity.position.distanceSquared(
							entity.position
						);
						if (distanceSq < minDistanceSq) {
							minDistanceSq = distanceSq;
							nearestHostile = entity;
						}
					}
				}
				if (nearestHostile) {
					await ensureBestGear(false);
					const goal = new GoalFollow(nearestHostile, 1.5);
					bot.pathfinder.setGoal(goal, true);
					console.log(
						`[Defensa Tick] Hostil más cercano: ${
							nearestHostile.name || nearestHostile.displayName
						}. Atacando.`
					);
					bot.attack(nearestHostile, true);
				} else {
					if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
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
			runNextCommandFromQueue();
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
						checkInterrupt();
						await bot.pathfinder.goto(
							new GoalNear(
								player.entity.position.x,
								player.entity.position.y,
								player.entity.position.z,
								2
							)
						);
						checkInterrupt();
						bot.chat(
							`Llegué, ${usernameForContext}. Aquí tienes tu ${itemName}.`
						);
						await tossItemCmd(itemName, amountStr);
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
				const itemName = args[0].toLowerCase();
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
			if (args.length === 2) {
				const destination = args[0].toLowerCase();
				const itemName = args[1];
				equipItemCmd(itemName, destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}equipar <destino> <nombre_item>`);
			}
		} else if (command === "desequipar" || command === "unequip") {
			if (args.length === 1) {
				const destination = args[0].toLowerCase();
				unequipItemCmd(destination);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}desequipar <destino>`);
			}
		} else if (command === "usar" || command === "use") {
			const itemName = args[0];
			useItemCmd(itemName);
		} else if (command === "fabricar" || command === "craft") {
			if (args.length >= 1) {
				const itemName = args[0];
				const amountStr = args[1];
				craftItemCmd(itemName, amountStr);
			} else {
				bot.chat(`Uso: ${BOT_COMMAND_PREFIX}fabricar <nombre_item> [cantidad]`);
			}
		} else if (command === "ayuda") {
			bot.chat(
				`Comandos: ${BOT_COMMAND_PREFIX}sigueme, quedate, ven, ve, aplana <largo> <ancho> [alto], ` +
					`consigue <item> [cantidad], protegeme, no_protejas, reanuda, inventario, ` +
					`dame <item> [cantidad], equipar <destino> <item>, desequipar <destino>, ` +
					`usar [item], fabricar <item> [cantidad], hambre. ` +
					`Para IA: ${BOT_COMMAND_PREFIX}chat <mensaje>. ` +
					`Para ayuda de aplana: ${BOT_COMMAND_PREFIX}aplana`
			);
		} else if (command === "hambre") {
			const foodLevel = bot.food;
			if (foodLevel >= 18) {
				bot.chat(`No tengo hambre. Mi nivel de comida es ${foodLevel}/20.`);
			} else if (foodLevel >= 10) {
				bot.chat(
					`Estoy un poco hambriento. Mi nivel de comida es ${foodLevel}/20.`
				);
			} else {
				bot.chat(
					`¡Tengo mucha hambre! Mi nivel de comida es ${foodLevel}/20. ¡Necesito comer algo!`
				);
			}
		} else {
			bot.chat(
				`No reconozco el comando '${command}'. Usa '${BOT_COMMAND_PREFIX}ayuda' para ver los disponibles.`
			);
		}
	}
});

bot.on("death", async () => {
	console.log(`[Death System] El bot ha muerto. Salud: ${bot.health}`);
	stopDefense(false);
	if (selfDefenseIntervalId) {
		clearInterval(selfDefenseIntervalId);
		selfDefenseIntervalId = null;
		isBotDefendingItself = false;
		currentSelfDefenseTarget = null;
	}
	if (autoEatIntervalId) {
		clearInterval(autoEatIntervalId);
		autoEatIntervalId = null;
		isEating = false;
	}
	if (currentCommand) {
		bot.pathfinder.stop();
		console.log(
			`[Death System] Comando actual '${currentCommand.name}' limpiado.`
		);
		currentCommand = null;
	}
	commandQueue = [];
	console.log("[Death System] Cola de comandos limpiada.");
	bot.pathfinder.setGoal(null);
	console.log("[Death System] Estado general limpiado tras la muerte.");
	capturedDeathMessage = "Desaparecí misteriosamente... ¡pero he vuelto!";
	console.log(
		`[Death System] Mensaje de muerte por defecto: "${capturedDeathMessage}"`
	);
});

bot.on("death_event", (victim, killer, message) => {
	if (victim && victim.username === bot.username && message) {
		capturedDeathMessage = message;
		console.log(
			`[Death Event Plugin] Razón de muerte capturada: "${capturedDeathMessage}"`
		);
	}
});

bot.on("playerLeft", (player) => {
	if (playerToDefend && player.username === playerToDefend.username) {
		bot.chat(`Parece que ${player.username} se ha ido. Dejaré de proteger.`);
		stopDefense(false);
	}
});
