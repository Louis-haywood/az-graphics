const sharp  = require('sharp');
const fs     = require('fs');
const path   = require('path');

const PORTFOLIO_DIR = path.join(__dirname, 'assets', 'portfolio');
const MAX_WIDTH     = 1920;
const JPEG_QUALITY  = 82;
const PNG_QUALITY   = 80;

async function compress() {
    const files = fs.readdirSync(PORTFOLIO_DIR)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f));

    let saved = 0;
    let count = 0;

    for (const file of files) {
        const filepath = path.join(PORTFOLIO_DIR, file);
        const before   = fs.statSync(filepath).size;
        const ext      = path.extname(file).toLowerCase();

        try {
            let pipeline = sharp(filepath).resize(MAX_WIDTH, null, { withoutEnlargement: true });

            let buf;
            if (ext === '.png') {
                buf = await pipeline.png({ quality: PNG_QUALITY, compressionLevel: 9 }).toBuffer();
            } else {
                buf = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
            }

            if (buf.length < before) {
                fs.writeFileSync(filepath, buf);
                const kb = ((before - buf.length) / 1024).toFixed(0);
                saved += (before - buf.length);
                count++;
                console.log(`✓ ${file} — saved ${kb}KB`);
            } else {
                console.log(`  ${file} — already optimal`);
            }
        } catch (e) {
            console.log(`  ${file} — skipped (${e.message})`);
        }
    }

    console.log(`\nDone — ${count} files compressed, ${(saved / 1024).toFixed(0)}KB total saved`);
}

compress();
