import { CronJob } from 'cron';
import express from 'express';
import https from 'https';
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Server is live on port ${PORT}`));

// get env RENDER_EXTERNAL_URL
const render_url = process.env.RENDER_EXTERNAL_URL

if (!render_url) {
    console.log("No RENDER_EXTERNAL_URL found. Please set it as environment variable.")
}

const job = new CronJob('*/14 * * * *', function() {
    console.log('Making keep alive call');

    https.get(render_url, (resp) => {
        if (resp.statusCode === 200) {
            console.log("Keep alive call successful");
        } else {
            console.log("Keep alive call failed");
        }
    }).on("error", (err) => {
        console.log("Error making keep alive call");
    });

});

export {job};
