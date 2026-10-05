const path = require('path');
const Jimp = require('jimp');
const { GifUtil, GifFrame, BitmapImage, GifCodec } = require('gifwrap');
const logger = require('../../../core/logger');
const { smallCaps } = require('../../../utils/textStyle');

const codec = new GifCodec();
const FONT_LADDER = [Jimp.FONT_SANS_32_BLACK, Jimp.FONT_SANS_16_BLACK, Jimp.FONT_SANS_8_BLACK];

const REVERSE_SMALL_CAPS = {};
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    for (const styled of smallCaps(ch)) REVERSE_SMALL_CAPS[styled] = ch;
}

let sourcePromise = null;
const fonts = new Map();
const encodeCache = new Map();
const CACHE_LIMIT = 25;

function loadFont(key) {
    if (!fonts.has(key)) fonts.set(key, Jimp.loadFont(key));
    return fonts.get(key);
}

function loadSource(config) {
    if (!sourcePromise) {
        const file = path.resolve(process.cwd(), config.gif?.path || './assets/welcome.gif');
        sourcePromise = GifUtil.read(file).catch(error => {
            logger.error(`Welcome card: cannot decode ${file}: ${error.message}`);
            sourcePromise = null;
            return null;
        });
    }
    return sourcePromise;
}

// Display names often use stylized Unicode (small-caps etc.) that bitmap fonts
// cannot draw; map them back to ASCII and drop anything else the font lacks.
function toDrawableName(raw) {
    let out = '';
    for (const ch of String(raw)) out += REVERSE_SMALL_CAPS[ch] ?? ch;
    return out
        .normalize('NFKD')
        .replace(/[^ -~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

async function placeName(name, width, height) {
    const spots = [
        { cx: width * 0.75, y: height * 0.66, maxW: width * 0.44 },
        { cx: width / 2, y: height * 0.86, maxW: width * 0.94 }
    ];
    for (const spot of spots) {
        for (const key of FONT_LADDER) {
            const font = await loadFont(key);
            const w = Jimp.measureText(font, name);
            if (w <= spot.maxW) return { font, text: name, x: spot.cx - w / 2, y: spot.y };
        }
    }
    const font = await loadFont(Jimp.FONT_SANS_8_BLACK);
    let text = name;
    while (text.length > 1 && Jimp.measureText(font, text) > spots[1].maxW) text = text.slice(0, -1);
    const w = Jimp.measureText(font, text);
    return { font, text, x: spots[1].cx - w / 2, y: spots[1].y };
}

function outlineThickness(font) {
    const size = Number(font?.info?.size) || 32;
    return Math.max(1, Math.round(size / 16));
}

function buildNameSprite(font, text, outline) {
    const pad = outline + 2;
    const lineHeight = Number(font.common?.lineHeight) || (Number(font.info?.size) || 32) * 2;
    const width = Math.max(1, Jimp.measureText(font, text));
    const sw = width + 2 * pad;
    const sh = lineHeight + 2 * pad;

    const glyph = new Jimp(sw, sh, 0x00000000);
    glyph.print(font, pad, pad, text);

    const src = glyph.bitmap.data;
    const mask = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) mask[i] = src[i * 4 + 3] >= 128 ? 1 : 0;

    const sprite = new Jimp(sw, sh, 0x00000000);
    const dst = sprite.bitmap.data;
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            if (mask[y * sw + x] === 0) continue;
            for (let dy = -outline; dy <= outline; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= sh) continue;
                for (let dx = -outline; dx <= outline; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= sw) continue;
                    const di = (ny * sw + nx) * 4;
                    dst[di] = 0;
                    dst[di + 1] = 0;
                    dst[di + 2] = 0;
                    dst[di + 3] = 255;
                }
            }
        }
    }
    for (let i = 0; i < sw * sh; i++) {
        if (mask[i] === 0) continue;
        const di = i * 4;
        dst[di] = 255;
        dst[di + 1] = 255;
        dst[di + 2] = 255;
        dst[di + 3] = 255;
    }

    return { sprite, pad };
}

function blit(canvas, frame) {
    const src = frame.bitmap;
    for (let y = 0; y < src.height; y++) {
        const row = (frame.yOffset + y) * canvas.width + frame.xOffset;
        for (let x = 0; x < src.width; x++) {
            const si = (y * src.width + x) * 4;
            if (src.data[si + 3] === 0) continue;
            const di = (row + x) * 4;
            canvas.data[di] = src.data[si];
            canvas.data[di + 1] = src.data[si + 1];
            canvas.data[di + 2] = src.data[si + 2];
            canvas.data[di + 3] = 255;
        }
    }
}

// GIFs store animation frames as partial patches; flatten them into full
// canvases so re-encoding cannot stamp a patch at the wrong position.
function flattenFrames(source) {
    const canvas = new BitmapImage({
        width: source.width,
        height: source.height,
        data: Buffer.alloc(source.width * source.height * 4)
    });
    const cb = canvas.bitmap;
    const canvases = [];
    for (const frame of source.frames) {
        blit(cb, frame);
        canvases.push(new BitmapImage({ width: cb.width, height: cb.height, data: Buffer.from(cb.data) }));
        if (frame.disposalMethod === 2) {
            const bg = cb.data.slice(0, 4);
            for (let y = 0; y < frame.bitmap.height; y++) {
                for (let x = 0; x < frame.bitmap.width; x++) {
                    const di = ((frame.yOffset + y) * cb.width + frame.xOffset + x) * 4;
                    cb.data.set(bg, di);
                }
            }
        }
    }
    return canvases;
}

/**
 * Bakes the member's name into a throwaway copy of the welcome GIF so it
 * appears inside the white card under "Hullo!". The source file on disk is
 * never touched. Returns null when compositing is impossible so callers
 * fall back to the plain GIF with the name line below it.
 */
async function composeWelcomeCard(member, config = {}) {
    if (config.gif?.source === 'url') return null;

    const name = toDrawableName(member.displayName ?? member.user?.username ?? '');
    if (!name) return null;
    if (encodeCache.has(name)) return encodeCache.get(name);

    const source = await loadSource(config);
    if (!source) return null;

    const { font, text, x, y } = await placeName(name, source.width, source.height);
    const px = Math.round(x);
    const py = Math.round(y);
    const { sprite, pad } = buildNameSprite(font, text, outlineThickness(font));

    const frames = await Promise.all(flattenFrames(source).map(async (canvas, i) => {
        const image = GifUtil.shareAsJimp(Jimp, canvas);
        image.composite(sprite, px - pad, py - pad);
        return new GifFrame(canvas, {
            delayCentisecs: source.frames[i].delayCentisecs,
            disposalMethod: 1
        });
    }));

    const gif = await codec.encodeGif(frames, { loops: source.loops });

    encodeCache.set(name, gif.buffer);
    if (encodeCache.size > CACHE_LIMIT) encodeCache.delete(encodeCache.keys().next().value);
    return gif.buffer;
}

module.exports = { composeWelcomeCard, toDrawableName };
