const fs = require('fs');

/* copies .env.sample to .env */
if (!fs.existsSync('.env')) {
    console.log('creating new .env from .env.sample...');
    fs.createReadStream('.env.sample').pipe(fs.createWriteStream('.env'));
} else {
    console.log('.env already exists');
}