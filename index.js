const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { OpenAI } = require("openai");
const { GoalBlock, GoalNear, GoalFollow } = goals;
require("dotenv").config(); // Carga variables de entorno desde .env

// Configurar el cliente de Shapes
const shapes_client = new OpenAI({
    apiKey: process.env.SHAPES_API_KEY, // Usa una variable de entorno para la API Key
    baseURL: "https://api.shapes.inc/v1",
});

// Crear el bot de Minecraft
const bot = mineflayer.createBot({
    host: process.env.SERVER_IP, // Dirección del servidor
    port: process.env.SERVER_PORT, // Puerto del servidor
    username: 'RodentBot', // Nombre del bot
     chat: 'legacy'
});

// Variables de estado
let mcData;
let movements;
let followingPlayer = null;
let staying = false;
let defending = false; // Para evitar listeners duplicados

bot.on('spawn', () => {
    console.log("Bot conectado, obteniendo versión...");

    mcData = require('minecraft-data')(bot.version); // Usa la versión del bot, no una fija

    if (!mcData || !mcData.blocksByName) {
        console.error("Error crítico: mcData no cargó correctamente.");
        return;
    }

    // Cargar el plugin pathfinder después de mcData
    bot.loadPlugin(pathfinder);

    console.log("Versión de Minecraft detectada:", bot.version);
    console.log("Bloques cargados:", Object.keys(mcData.blocksByName));

    movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    bot.chat("¡Hola! Soy RodentBot, listo para jugar en Minecraft.");
});

// Función para obtener respuesta de la IA
async function getShapeResponse(prompt) {
    try {
        const response = await shapes_client.chat.completions.create({
            model: process.env.MODEL_NAME,
            messages: [{ role: "user", content: prompt }]
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error en la API de Shapes:", error);
        return "Lo siento, no pude procesar tu mensaje.";
    }
}

// **Acciones del bot según el chat**
bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    // Convertir el mensaje a minúsculas para evitar problemas con mayúsculas
    const msgLower = message.toLowerCase();

    // Verificar si el mensaje comienza con el comando
    if (!msgLower.startsWith(process.env.COMMAND)) return;

    const args = msgLower.slice(8).trim().split(" ");
    const command = args[0];

    if (command === "sigueme") {
        const player = bot.players[username];
        if (player && player.entity) {
            followingPlayer = player;
            bot.chat(`¡Te seguiré, ${username}!`);
            bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
        } else {
            bot.chat("No puedo encontrarte para seguirte.");
        }
    } else if (command === "quedate") {
        staying = true;
        bot.chat("¡Me quedaré aquí!");
        bot.pathfinder.setGoal(null); // Detiene el movimiento
    } else if (command === "ven") {
        const player = bot.players[username];
        if (player && player.entity) {
            bot.pathfinder.setGoal(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 1));
            bot.chat(`¡Voy hacia ti, ${username}!`);
        } else {
            bot.chat("No puedo ir hacia ti porque no te encuentro.");
        }
    } else if (command === "ve") {
        if (args.length === 4) {
            const x = parseInt(args[1]);
            const y = parseInt(args[2]);
            const z = parseInt(args[3]);
            if (isNaN(x) || isNaN(y) || isNaN(z)) {
                bot.chat("Las coordenadas no son válidas.");
            } else {
                bot.pathfinder.setGoal(new GoalBlock(x, y, z));
                bot.chat(`¡Voy a las coordenadas ${x}, ${y}, ${z}!`);
            }
        } else if (args.length === 2) {
            const targetPlayer = args[1];
            const player = bot.players[targetPlayer];
            if (player && player.entity) {
                bot.pathfinder.setGoal(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 1));
                bot.chat(`¡Voy hacia ${targetPlayer}!`);
            } else {
                bot.chat(`No encuentro al jugador ${targetPlayer}.`);
            }
        } else {
            bot.chat("Uso correcto: !rodent ve <x> <y> <z> o !rodent ve <jugador>");
        }
    } else if (command === "aplana") {
        const size = parseInt(args[1]);
        if (isNaN(size) || size < 1 || size > 10) {
            bot.chat("Indica un tamaño válido (1-10). Ejemplo: !rodent aplana 3");
            return;
        }
        bot.chat(`¡Voy a aplanar un área de ${size} bloques!`);
        for (let dx = -size; dx <= size; dx++) {
            for (let dz = -size; dz <= size; dz++) {
                const block = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
                if (block && bot.canSeeBlock(block)) {
                    try {
                        await bot.dig(block);
                    } catch (err) {
                        console.error("Error al picar bloque:", err);
                    }
                }
            }
        }
    } else if (command === "consigue") {
        const mineral = args[1];
        if (!mineral) {
            bot.chat("Indica el nombre del mineral. Ejemplo: !rodent consigue iron_ore");
            return;
        }
        const blockId = mcData.blocksByName[mineral]?.id || null;
        if (!blockId) {
            bot.chat(`El mineral "${mineral}" no existe.`);
            return;
        }
        bot.chat(`¡Buscando ${mineral}!`);
        const block = bot.findBlock({
            matching: blockId,
            maxDistance: 32
        });
        if (block) {
            bot.pathfinder.setGoal(new GoalBlock(block.position.x, block.position.y, block.position.z));
            try {
                await bot.dig(block);
            } catch (err) {
                bot.chat("No pude picar el bloque.");
            }
        } else {
            bot.chat(`No encontré ${mineral} cerca.`);
        }
    } else if (command === "protegeme") {
        if (defending) {
            bot.chat("Ya estoy en modo defensa.");
            return;
        }
        defending = true;
        bot.chat("¡Activando modo defensa!");
        const defenseListener = (entity) => {
            if (entity.type === 'mob' && entity.position.distanceTo(bot.entity.position) < 10) {
                bot.attack(entity);
                bot.chat(`¡Atacando a ${entity.name}!`);
            }
        };
        bot._defenseListener = defenseListener;
        bot.on('entitySpawn', defenseListener);
    } else if (command === "reanuda") {
        staying = false;
        bot.chat("¡Listo para moverte de nuevo!");
    } else if (command === "ayuda") {
        bot.chat("Comandos disponibles: sigueme, quedate, ven, ve, aplana, consigue, protegeme, reanuda");
    } else {
        bot.chat("No reconozco ese comando. Usa '!rodent ayuda' para ver los disponibles.");
    }
});

// Eventos adicionales
bot.on('death', () => {
    bot.chat("¡Oh no! Volveré pronto.");
    defending = false;
    if (bot._defenseListener) {
        bot.removeListener('entitySpawn', bot._defenseListener);
        bot._defenseListener = null;
    }
});
