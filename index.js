const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');
require('dotenv').config();

const bot = mineflayer.createBot({
    host: process.env.SERVER_IP, // Dirección del servidor
    port: process.env.SERVER_PORT, // Puerto del servidor
    username: 'RodentBot' // Nombre del bot
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
    console.log('Bot conectado al servidor');
    bot.chat('¡Hola! Soy RodentBot.');
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    // Comando para moverse cerca de un jugador
    if (message.startsWith('!ven ')) {
        const targetName = message.split(' ')[1];
        const target = bot.players[targetName] ? bot.players[targetName].entity : null;
        if (!target) {
            bot.chat(`No veo al jugador ${targetName} en línea.`);
            return;
        }
        const p = target.position;
        bot.pathfinder.setMovements(new Movements(bot));
        bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 1));
        bot.chat(`Voy hacia ${targetName}.`);
    }

    // Comando para decir algo
    if (message.startsWith('!di ')) {
        const sayMessage = message.substring(3);
        bot.chat(sayMessage);
    }

    // Comando para picar un bloque
    if (message.startsWith('!pica ')) {
        const args = message.split(' ');
        if (args.length < 4) {
            bot.chat('Uso: pica <x> <y> <z>');
            return;
        }
        const x = parseInt(args[1]);
        const y = parseInt(args[2]);
        const z = parseInt(args[3]);
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) {
            bot.chat('No hay bloque en esa posición.');
            return;
        }
        try {
            await bot.dig(block);
            bot.chat('¡Bloque picado!');
        } catch (err) {
            bot.chat('No pude picar el bloque: ' + err.message);
        }
    }

    // Comando para colocar un bloque
    if (message.startsWith('!coloca ')) {
        const args = message.split(' ');
        if (args.length < 5) {
            bot.chat('Uso: coloca <nombreBloque> <x> <y> <z>');
            return;
        }
        const blockName = args[1];
        const x = parseInt(args[2]);
        const y = parseInt(args[3]);
        const z = parseInt(args[4]);
        const referenceBlock = bot.blockAt(new Vec3(x, y - 1, z));
        if (!referenceBlock) {
            bot.chat('No puedo encontrar un bloque de referencia.');
            return;
        }
        const item = bot.inventory.items().find(i => i.name === blockName);
        if (!item) {
            bot.chat(`No tengo el bloque ${blockName}.`);
            return;
        }
        try {
            await bot.equip(item, 'hand');
            await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
            bot.chat('¡Bloque colocado!');
        } catch (err) {
            bot.chat('No pude colocar el bloque: ' + err.message);
        }
    }
});

bot.on('goal_reached', () => {
    bot.chat('¡He llegado a mi destino!');
});

bot.on('death', () => {
    bot.chat('¡He muerto!');
});

bot.on('kicked', (reason) => {
    console.log('Expulsado por:', reason);
});

bot.on('error', (err) => {
    console.log('Error:', err);
});
