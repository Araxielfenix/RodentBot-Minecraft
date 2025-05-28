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
    username: 'RodentBot' // Nombre del bot
});

// Agregar el módulo de pathfinding
bot.loadPlugin(pathfinder);

// Variables de estado
let mcData;
let movements;
let followingPlayer = null;
let staying = false;

// Cuando el bot se conecta, definimos mcData y movements
bot.on('spawn', () => {
    console.log("Bot conectado, obteniendo versión...");
    
    mcData = require('minecraft-data')(bot.version);
    if (!mcData) {
        console.error("Error: mcData no se pudo cargar correctamente.");
        return;
    }

    console.log("Versión de Minecraft:", bot.version);
    console.log("Datos de Minecraft cargados:", mcData);

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

    // Verificar si el mensaje comienza con "!rodent"
    if (!msgLower.startsWith("!rodent")) return;

    const args = msgLower.slice(8).trim().split(" "); // Eliminar "!rodent" y dividir el mensaje
    const command = args[0];

    if (command === "sigueme") {
        followingPlayer = bot.players[username];
        if (followingPlayer) {
            bot.chat(`¡Te seguiré, ${username}!`);
            bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
        }
    } else if (command === "quedate") {
        staying = true;
        bot.chat("¡Me quedaré aquí!");
        bot.pathfinder.setGoal(null); // Detiene el movimiento
    } else if (command === "ven") {
        const player = bot.players[username];
        if (player) {
            bot.pathfinder.setGoal(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 1));
            bot.chat(`¡Voy hacia ti, ${username}!`);
        }
    } else if (command === "ve") {
        if (args.length === 4) {
            const x = parseInt(args[1]);
            const y = parseInt(args[2]);
            const z = parseInt(args[3]);
            bot.pathfinder.setGoal(new GoalBlock(x, y, z));
            bot.chat(`¡Voy a las coordenadas ${x}, ${y}, ${z}!`);
        } else if (args.length === 2) {
            const targetPlayer = args[1];
            const player = bot.players[targetPlayer];
            if (player) {
                bot.pathfinder.setGoal(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 1));
                bot.chat(`¡Voy hacia ${targetPlayer}!`);
            }
        }
    } else if (command === "aplana") {
        const size = parseInt(args[1]);
        bot.chat(`¡Voy a aplanar un área de ${size} bloques!`);
        for (let dx = -size; dx <= size; dx++) {
            for (let dz = -size; dz <= size; dz++) {
                const block = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
                if (block && bot.canSeeBlock(block)) {
                    bot.dig(block);
                }
            }
        }
    } else if (command === "consigue") {
        const mineral = args[1];
        bot.chat(`¡Buscando ${mineral}!`);
        const block = bot.findBlock({
            matching: mcData.blocksByName[mineral]?.id || null,
            maxDistance: 32
        });
        if (block) {
            bot.pathfinder.setGoal(new GoalBlock(block.position.x, block.position.y, block.position.z));
            bot.dig(block);
        } else {
            bot.chat(`No encontré ${mineral} cerca.`);
        }
    } else if (command === "protegeme") {
        bot.chat("¡Activando modo defensa!");
        bot.on('entitySpawn', (entity) => {
            if (entity.type === 'mob' && entity.position.distanceTo(bot.entity.position) < 10) {
                bot.attack(entity);
                bot.chat(`¡Atacando a ${entity.name}!`);
            }
        });
    } else if (command === "reanuda") {
        staying = false;
        bot.chat("¡Listo para moverte de nuevo!");
    } else {
        bot.chat("No reconozco ese comando. Usa `!Rodent ayuda` para ver los disponibles.");
    }
});

// Eventos adicionales
bot.on('death', () => {
    bot.chat("¡Oh no! Volveré pronto.");
});
