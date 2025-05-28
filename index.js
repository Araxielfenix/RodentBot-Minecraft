const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { OpenAI } = require("openai");
const { GoalBlock, GoalNear, GoalFollow } = goals;
import dotenv from "dotenv";
dotenv.config();

// Configurar el cliente de Shapes
const shapes_client = new OpenAI({
    apiKey: process.env.SHAPES_API_KEY,
    baseURL: "https://api.shapes.inc/v1",
});

// Crear el bot de Minecraft
const bot = mineflayer.createBot({
    host: 'RodentPlay.aternos.me', // Dirección del servidor
    port: 22246, // Puerto del servidor
    username: 'RodentBot' // Nombre del bot
});

// Agregar el módulo de pathfinding
bot.loadPlugin(pathfinder);

// Configurar movimientos
const mcData = require('minecraft-data')(bot.version);
const movements = new Movements(bot, mcData);
bot.pathfinder.setMovements(movements);

// Variables de estado
let followingPlayer = null;
let staying = false;

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

    const args = message.split(" ");
    const command = args[0].toLowerCase();

    if (command === "ven") {
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
            matching: mcData.blocksByName[mineral].id,
            maxDistance: 32
        });
        if (block) {
            bot.pathfinder.setGoal(new GoalBlock(block.position.x, block.position.y, block.position.z));
            bot.dig(block);
        } else {
            bot.chat(`No encontré ${mineral} cerca.`);
        }
    } else if (command === "cuidame") {
        bot.chat("¡Activando modo defensa!");
        bot.on('entitySpawn', (entity) => {
            if (entity.type === 'mob' && entity.position.distanceTo(bot.entity.position) < 10) {
                bot.attack(entity);
                bot.chat(`¡Atacando a ${entity.name}!`);
            }
        });
    } else if (command === "sigueme") {
        followingPlayer = bot.players[username];
        if (followingPlayer) {
            bot.chat(`¡Te seguiré, ${username}!`);
            bot.pathfinder.setGoal(new GoalFollow(followingPlayer.entity, 1), true);
        }
    } else if (command === "quedate") {
        staying = true;
        bot.chat("¡Me quedaré aquí!");
        bot.pathfinder.setGoal(null); // Detiene el movimiento
    } else if (command === "continua") {
        staying = false;
        bot.chat("¡Listo para moverte de nuevo!");
    } else {
        const reply = await getShapeResponse(message);
        bot.chat(reply);
    }
});

// Eventos adicionales
bot.on('spawn', () => {
    bot.chat("¡Hola! Soy RodentPlay, tu compañero IA en este mundo de Minecraft.");
});

bot.on('death', () => {
    bot.chat("¡Oh no! Me he quedado sin vidas. Volveré pronto.");
});
