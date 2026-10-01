const fs = require('fs');
const path = require('path');

const size = 256;
const supersampling = 4;
const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
const bytesPerPixel = 4;

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mix(start, end, amount) {
  return start + (end - start) * amount;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const amount = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / length));
  return Math.hypot(px - x1 - amount * dx, py - y1 - amount * dy);
}

function strokeCoverage(x, y, points, width) {
  for (let index = 0; index < points.length - 1; index += 1) {
    if (distanceToSegment(x, y, ...points[index], ...points[index + 1]) <= width / 2) return true;
  }
  return false;
}

function roundedRectangleContains(x, y, left, top, right, bottom, radius) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const halfWidth = (right - left) / 2;
  const halfHeight = (bottom - top) / 2;
  const dx = Math.abs(x - centerX) - (halfWidth - radius);
  const dy = Math.abs(y - centerY) - (halfHeight - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= radius;
}

function renderPixel(pixelX, pixelY) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;

  for (let sampleY = 0; sampleY < supersampling; sampleY += 1) {
    for (let sampleX = 0; sampleX < supersampling; sampleX += 1) {
      const x = pixelX + (sampleX + 0.5) / supersampling;
      const y = pixelY + (sampleY + 0.5) / supersampling;
      let color;
      let sampleAlpha = 0;

      if (roundedRectangleContains(x, y, 12, 12, 244, 244, 50)) {
        const gradient = Math.max(0, Math.min(1, ((x - 16) * 0.47 + (y - 12) * 0.53) / 224));
        const shine = Math.max(0, Math.min(0.2, (0.46 - y / 256) * 0.23));
        color = [
          mix(67, 22, gradient),
          mix(138, 55, gradient),
          mix(245, 143, gradient)
        ].map((channel) => mix(channel, 255, shine));
        sampleAlpha = 255;
      } else if (roundedRectangleContains(x, y, 6, 6, 250, 250, 55)) {
        const distance = Math.min(x - 6, 250 - x, y - 6, 250 - y);
        const shade = Math.max(0, 1 - distance / 16) * 0.28;
        color = [12, 27, 58].map((channel) => channel * (1 - shade));
        sampleAlpha = 255;
      } else {
        color = [0, 0, 0];
      }

      const jPath = [[79, 83], [136, 83], [136, 155], [133, 166], [126, 174], [115, 178], [102, 176], [91, 168]];
      const sPath = [[181, 101], [172, 92], [160, 87], [147, 87], [138, 91], [133, 99], [134, 108], [140, 114], [152, 119], [169, 125], [179, 132], [183, 141], [182, 151], [176, 161], [166, 168], [151, 171], [137, 168], [125, 160]];
      if (strokeCoverage(x, y, jPath, 13) || strokeCoverage(x, y, sPath, 13)) {
        color = [255, 255, 255];
      }
      alpha += sampleAlpha;

      red += color[0];
      green += color[1];
      blue += color[2];
    }
  }

  const sampleCount = supersampling * supersampling;
  return [
    clamp(blue / sampleCount),
    clamp(green / sampleCount),
    clamp(red / sampleCount),
    clamp(alpha / sampleCount)
  ];
}

const pixelData = Buffer.alloc(size * size * bytesPerPixel);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = ((size - 1 - y) * size + x) * bytesPerPixel;
    renderPixel(x, y).forEach((channel, index) => {
      pixelData[offset + index] = channel;
    });
  }
}

const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
const bitmapHeader = Buffer.alloc(40);
bitmapHeader.writeUInt32LE(40, 0);
bitmapHeader.writeInt32LE(size, 4);
bitmapHeader.writeInt32LE(size * 2, 8);
bitmapHeader.writeUInt16LE(1, 12);
bitmapHeader.writeUInt16LE(32, 14);
bitmapHeader.writeUInt32LE(pixelData.length + mask.length, 20);

const imageData = Buffer.concat([bitmapHeader, pixelData, mask]);
const iconHeader = Buffer.alloc(6);
iconHeader.writeUInt16LE(0, 0);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);

const directoryEntry = Buffer.alloc(16);
directoryEntry.writeUInt8(0, 0);
directoryEntry.writeUInt8(0, 1);
directoryEntry.writeUInt8(0, 2);
directoryEntry.writeUInt8(0, 3);
directoryEntry.writeUInt16LE(1, 4);
directoryEntry.writeUInt16LE(32, 6);
directoryEntry.writeUInt32LE(imageData.length, 8);
directoryEntry.writeUInt32LE(iconHeader.length + directoryEntry.length, 12);

fs.mkdirSync(path.dirname(iconPath), { recursive: true });
fs.writeFileSync(iconPath, Buffer.concat([iconHeader, directoryEntry, imageData]));
console.log(`Created ${iconPath}`);
