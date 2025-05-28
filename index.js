const mineflayer = require('mineflayer');
const { OpenAI } = require("openai");

// Configurar el cliente de Shapes
const shapes_client = new OpenAI({
    apiKey: "<your-API-key>", // Reemplázalo con tu clave de API
    baseURL: "https://api.shapes.inc/v1",
});

// Crear el bot de Minecraft
const bot = mineflayer.createBot({
    host: 'RodentPlay.aternos.me', // Dirección del servidor
    port: 22246, // Puerto del servidor
    username: 'ChatGPTBot' // Nombre del bot
});

// Función para obtener respuesta de la IA
async function getShapeResponse(prompt) {
    try {
        const response = await shapes_client.chat.completions.create({
            model: "shapesinc/RodentPlay",
            messages: [{ role: "user", content: prompt }]
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error en la API de Shapes:", error);
        return "Lo siento, no pude procesar tu mensaje.";
    }
}

// Capturar mensajes del chat de Minecraft y responder con la IA
bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    console.log(`${username}: ${message}`);
    const reply = await getShapeResponse(message);
    bot.chat(reply);
});

// Eventos adicionales para mejorar la interacción
bot.on('spawn', () => {
    bot.chat("¡Hola! Soy RodentPlay, tu compañero IA en este mundo de Minecraft.");
});

bot.on('playerCollect', (collector, collected) => {
    bot.chat(`¡Bien hecho, ${collector.username}! Has recolectado ${collected.displayName}.`);
});

bot.on('entityHurt', (entity) => {
    bot.chat(`¡Cuidado, ${entity.name}!`);
});

bot.on('death', () => {
    bot.chat("¡Oh no! Me he quedado sin vidas. Volveré pronto.");
});
