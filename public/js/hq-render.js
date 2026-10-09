// The workshop building drawn on a canvas (docs/hq.md): the approved drawing, the furniture drawn in code over it, the
// actors from the sprite sheets, the links, cards, tool icons and the waiting rings of a scene (hq-scene.js
// sceneFrom). It only reads the scene and the view; the screens (views/workshop.js, hq-today.js) own the input.
// Colours come from the theme (public/css/theme.css --hq-* and the state colours); nothing here names a colour.
import { ART, FLOORS, ROOMS, LIFT_BOX, LIFT_X, baseKind, fixtureList, moveCellRect, actorPose, waitRing, walkingRoute, routePosition, jobLamps } from './hq-scene.js';

const FONT = '"Segoe UI", "Ubuntu Sans", Ubuntu, Cantarell, "Noto Sans", system-ui, sans-serif';
const IMAGES = {
  building: 'hq-tower',
  rear: 'hq-rear',
  activities: 'hq-activity',
  actors: 'hq-actors',
  chair: 'hq-chair',
  person: 'hq-move-person',
  robot: 'hq-move-robot',
};
// The theme's colours the canvas uses (read from the CSS variables of the same names)
const COLORS = ['bg', 'panel', 'text', 'muted', 'accent', 'busy', 'idle', 'stop', 'gold', 'pink', 'teal', 'hq-bg', 'hq-plate', 'hq-card', 'hq-mark', 'hq-line', 'hq-text', 'hq-note-text', 'hq-gold', 'hq-gold-2', 'hq-focus', 'hq-hover', 'hq-flash', 'hq-shade', 'hq-person-shirt', 'hq-person-hair', 'hq-skin', 'hq-skin-shade', 'hq-metal', 'hq-metal-dark', 'hq-chair-body', 'hq-shoe'];
// The rows of the activity sheet (hq-activity.png, 4 x 4): a robot and a person standing at work, a person and a robot
// reading seated; top and bottom of each row's figures
const ACTIVITY_ROWS = [
  { top: 62, bottom: 424 },
  { top: 442, bottom: 832 },
  { top: 860, bottom: 1182 },
  { top: 1196, bottom: 1514 },
];
// Tool icons, 2 x 2 pixels a dot, drawn in code (no emoji: Windows draws those differently)
const PIXELS = {
  read: ['00111100111100', '01000111000100', '01000111000100', '01000111000100', '01000111000100', '01000111000100', '01111111111100'],
  write: ['00000000001100', '00000000011000', '00000000110000', '00000001100000', '00000011000000', '00000110000000', '00001100000000', '00011100000000', '00111000000000', '00110000000000'],
  shell: ['01000000000000', '00100000000000', '00010000000000', '00100000000000', '01000001111100'],
  web: ['00001111000000', '00110000110000', '01001001001000', '11111111111100', '01001001001000', '00110000110000', '00001111000000'],
  agent: ['00111111110000', '00100000010000', '00101111010000', '00101001010000', '00101111010000', '00100000010000', '00111111110000'],
  skill: ['00000100000000', '00001110000000', '01111111111000', '00111111110000', '00011111000000', '00111011100000', '00100000100000'],
  workflow: ['00011001100000', '00111111110000', '01110000111000', '01100110011000', '01100110011000', '01110000111000', '00111111110000', '00011001100000'],
  mcp: ['00010001000000', '00010001000000', '00111111100000', '00111111100000', '00011111000000', '00000100000000', '00000100000000'],
  other: ['00000000000000', '00001110000000', '00001110000000', '00001110000000'],
};
// The whole house, one floor, or one room, in drawing pixels
const WHOLE = { x: 185, y: 95, w: 1220, h: 850 };

const lerp = (a, b, p) => a + (b - a) * p;
// A job card's ride from the lobby to the main room
const JOB_CARD_MS = 2600;

export class HqRenderer {
  // word(key, vars): a ws* string (strings/workshop.js); onChange: an image came in (draw again)
  constructor(canvas, { word, onChange } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.word = word;
    this.onChange = onChange;
    this.palette = {};
    this.assets = {};
    this.buffer = null;
    this.view = { room: null, floor: null, focus: null, highlight: null, eventActor: null, hover: null, selected: null, manualDoors: new Set(), still: false };
    this.readPalette();
    this.ready = Promise.all(
      Object.entries(IMAGES).map(
        ([name, file]) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              if (this.dead) return resolve();
              this.assets[name] = img;
              this.buffer = null;
              this.onChange?.();
              resolve();
            };
            img.onerror = () => resolve();
            img.src = new URL(`../img/building/${file}.png`, import.meta.url).href;
          }),
      ),
    );
  }

  // The theme's colours as the canvas sees them: the scene is a "dusk" element, so it keeps the dark values in the
  // light theme too (theme.css)
  readPalette() {
    const style = getComputedStyle(this.cv);
    for (const name of COLORS) this.palette[name] = style.getPropertyValue(`--${name}`).trim();
    this.buffer = null;
  }

  // The canvas follows its CSS box (at most twice the pixels on a high-density screen)
  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.cv.width === w && this.cv.height === h) return false;
    this.cv.width = w;
    this.cv.height = h;
    return true;
  }

  // What the camera looks at: one room, one floor or the whole house (drawing pixels)
  camera() {
    const v = this.view;
    if (v.room) {
      const room = ROOMS.find((r) => r.id === v.room);
      const f = FLOORS[room.floor];
      return { x: room.x0 - 30, y: f.y - 30, w: room.x1 - room.x0 + 65, h: f.h + 90 };
    }
    if (v.floor == null) return WHOLE;
    const f = FLOORS[v.floor];
    return { x: 285, y: f.y - 25, w: 1110, h: f.h + 72 };
  }

  transform() {
    const c = this.camera();
    const k = Math.min(this.cv.width / c.w, this.cv.height / c.h);
    return { ...c, k, ox: (this.cv.width - c.w * k) / 2, oy: (this.cv.height - c.h * k) / 2 };
  }

  // A pointer's place in drawing pixels
  pointerWorld(clientX, clientY) {
    const r = this.cv.getBoundingClientRect();
    const t = this.transform();
    return { x: (((clientX - r.left) * this.cv.width) / r.width - t.ox) / t.k + t.x, y: (((clientY - r.top) * this.cv.height) / r.height - t.oy) / t.k + t.y };
  }

  // A drawing point on the screen (for menus and the keyboard's anchor)
  clientOf(x, y) {
    const r = this.cv.getBoundingClientRect();
    const t = this.transform();
    return { x: r.left + (((x - t.x) * t.k + t.ox) * r.width) / this.cv.width, y: r.top + (((y - t.y) * t.k + t.oy) * r.height) / this.cv.height };
  }

  // Where an actor is drawn: at its seat with reduced motion, else where it walks
  position(a) {
    return this.view.still ? { ...a.destination } : { x: a.x, y: a.y };
  }

  // What is under a drawing point: an actor, a door, a piece of furniture, the lift or a room
  hitTarget(scene, p) {
    const bounds = this.camera();
    if (!scene || p.x < bounds.x || p.x > bounds.x + bounds.w || p.y < bounds.y || p.y > bounds.y + bounds.h) return null;
    const actor = [...scene.actors].reverse().find((a) => {
      if (a.pose.alpha <= 0.05 || (this.view.still && a.goneAt != null)) return false;
      const q = this.position(a);
      if (q.y < bounds.y || q.y > bounds.y + bounds.h || q.x < bounds.x || q.x > bounds.x + bounds.w) return false;
      return Math.abs(p.x - q.x) < 38 && p.y > q.y - 90 && p.y < q.y + 35;
    });
    if (actor) return { kind: 'actor', id: actor.id, data: actor };
    const door = scene.doors.find((d) => Math.abs(p.x - d.x) < 17 && p.y > d.y - 95 && p.y < d.y);
    if (door) return { kind: 'door', id: door.id, data: door };
    const fixture = scene.fixtures.find((f) => p.x >= f.x0 && p.x <= f.x1 && p.y >= f.y0 && p.y <= f.y1);
    if (fixture) return { kind: 'fixture', id: fixture.id, data: fixture };
    if (p.x >= LIFT_BOX.x && p.x <= LIFT_BOX.x + LIFT_BOX.w && p.y >= LIFT_BOX.y && p.y <= LIFT_BOX.y + LIFT_BOX.h) return { kind: 'lift', id: 'lift' };
    const room = ROOMS.find((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= FLOORS[r.floor].y && p.y <= FLOORS[r.floor].feet);
    return room ? { kind: 'room', id: room.id, data: room } : null;
  }

  // The floor under a drawing point (a double click goes into it)
  floorAt(p) {
    return FLOORS.findIndex((f) => p.y >= f.y && p.y <= f.feet);
  }

  // One of four accent colours per lead, the same everywhere for the same id
  actorColor(id) {
    const p = this.palette;
    return [p.accent, p.pink, p.teal, p.gold][[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];
  }

  // ---------- the house (cached: the drawing with its furniture) ----------
  cachedBuilding() {
    if (this.buffer) return this.buffer;
    const buf = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(ART.w, ART.h) : Object.assign(document.createElement('canvas'), { width: ART.w, height: ART.h });
    const b = buf.getContext('2d');
    b.imageSmoothingEnabled = false;
    b.fillStyle = this.palette['hq-bg'];
    b.fillRect(0, 0, ART.w, ART.h);
    if (this.assets.building) b.drawImage(this.assets.building, 0, 0, ART.w, ART.h);
    else {
      // Without the drawing: plain boxes for the rooms, so the scene still works
      for (const room of ROOMS) {
        const f = FLOORS[room.floor];
        b.fillStyle = this.palette[room.kind === 'server' ? 'hq-plate' : 'hq-card'];
        b.fillRect(room.x0, f.y, room.x1 - room.x0, f.h);
        b.strokeStyle = this.palette['hq-line'];
        b.strokeRect(room.x0, f.y, room.x1 - room.x0, f.h);
        b.fillStyle = this.palette['hq-gold'];
        b.font = `16px ${FONT}`;
        b.fillText(this.word(room.kind), room.x0 + 10, f.y + 24);
      }
    }
    for (const room of ROOMS) this.drawRoomDecor(b, room);
    for (const fixture of fixtureList([])) this.drawFixture(b, fixture);
    this.buffer = buf;
    return buf;
  }

  box(c, color, x, y, w, h) {
    c.fillStyle = this.palette[color];
    c.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // One piece of furniture at a seat: a computer desk, the meeting table, a server rack, an easel, a reading or lounge
  // chair (drawn once into the cached house)
  drawFixture(c, fixture) {
    const { x, feet, activity } = fixture;
    const box = (color, dx, dy, w, h) => this.box(c, color, x + dx, feet + dy, w, h);
    if (activity === 'desk') {
      // The monitor stands behind the actor, on the back wall
      box('hq-metal-dark', -40, -45, 5, 45);
      box('hq-metal-dark', 35, -45, 5, 45);
      box('hq-gold', -46, -51, 92, 6);
      box('hq-gold-2', -46, -52, 92, 2);
      box('hq-metal-dark', -3, -76, 6, 22);
      box('hq-chair-body', -27, -113, 54, 38);
      box('accent', -24, -110, 48, 32);
      box('hq-plate', -22, -108, 44, 28);
      box('teal', -18, -103, 30, 2);
      box('busy', -18, -97, 19, 2);
      box('hq-line', -18, -91, 34, 2);
      box('hq-metal-dark', -13, -56, 26, 3);
      box('hq-chair-body', -17, -52, 34, 3);
    } else if (activity === 'meeting') {
      if (this.assets.chair) {
        const r = moveCellRect({ x: x - 43, y: feet - 86, w: 86, h: 86 }, 'person');
        c.drawImage(this.assets.chair, r.x, r.y, r.w, r.h);
      } else {
        box('hq-chair-body', -27, -39, 26, 6);
        box('hq-metal-dark', -25, -32, 5, 32);
        box('hq-chair-body', -30, -72, 7, 36);
        box('hq-metal-dark', -26, -68, 2, 23);
      }
      box('hq-gold', 18, -44, 79, 6);
      box('hq-gold-2', 18, -45, 79, 2);
      box('hq-metal-dark', 22, -38, 5, 38);
      box('hq-metal-dark', 88, -38, 5, 38);
      box('hq-chair-body', 27, -49, 26, 4);
      box('hq-metal-dark', 28, -48, 24, 1);
      // papers and a cup on the table
      box('hq-text', 51, -49, 25, 3);
      box('hq-gold', 76, -59, 7, 13);
      box('hq-text', 78, -58, 3, 6);
    } else if (activity === 'rack') {
      box('hq-metal-dark', 21, -109, 70, 109);
      box('hq-chair-body', 25, -106, 62, 103);
      box('hq-plate', 29, -102, 54, 95);
      for (let row = 0; row < 7; row++) {
        box('hq-line', 31, -96 + row * 12, 48, 9);
        box('hq-plate', 34, -94 + row * 12, 35, 5);
        box('busy', 73, -94 + row * 12, 3, 3);
        box('accent', 35, -94 + row * 12, 5, 2);
      }
      box('hq-metal-dark', 25, -108, 62, 3);
      box('hq-metal-dark', 26, -3, 60, 3);
      box('hq-shade', 25, -105, 3, 101);
      box('hq-line', 83, -105, 3, 101);
      box('hq-metal-dark', 39, -106, 36, 2);
    } else if (activity === 'draw') {
      box('hq-gold', 39, -36, 5, 36);
      box('hq-gold', 84, -36, 5, 36);
      box('hq-gold', 60, -111, 5, 95);
      box('hq-gold-2', 31, -104, 68, 70);
      box('hq-text', 35, -100, 60, 59);
      box('accent', 42, -94, 46, 5);
      box('hq-line', 42, -84, 12, 30);
      box('teal', 57, -84, 31, 4);
      box('pink', 57, -77, 14, 12);
      box('hq-gold', 74, -77, 14, 12);
      box('teal', 57, -61, 31, 3);
      box('hq-gold', 29, -38, 73, 5);
      box('hq-metal-dark', 60, -106, 11, 4);
    } else if (activity === 'read' || activity === 'rest') {
      const read = activity === 'read';
      box('hq-chair-body', -30, -42, 61, 39);
      box(read ? 'hq-mark' : 'hq-person-shirt', -27, -39, 54, 32);
      box('hq-line', -25, -38, 50, 2);
      box('hq-metal-dark', -32, -32, 7, 28);
      box('hq-metal-dark', 26, -32, 7, 28);
      box(read ? 'hq-gold' : 'hq-line', -24, -18, 48, 12);
      box('hq-chair-body', -24, -6, 48, 3);
      box('hq-gold', -20, -4, 5, 4);
      box('hq-gold', 18, -4, 5, 4);
      box('hq-chair-body', -1, -35, 2, 14);
      if (!read) {
        // a low table with a cup
        box('hq-gold', 49, -20, 37, 5);
        box('hq-metal-dark', 53, -15, 4, 15);
        box('hq-metal-dark', 78, -15, 4, 15);
        box('hq-text', 62, -29, 9, 9);
      }
    }
  }

  // A bookcase in the library, a screen on the lounge wall
  drawRoomDecor(c, room) {
    const f = FLOORS[room.floor];
    const x = room.x1 - 38;
    const y = f.y + 35;
    const box = (color, bx, by, w, h) => this.box(c, color, bx, by, w, h);
    if (room.kind === 'library') {
      box('hq-mark', x, y, 31, 102);
      box('hq-gold', x, y, 3, 102);
      box('hq-gold', x + 28, y, 3, 102);
      for (let shelf = 0; shelf < 4; shelf++) {
        for (let book = 0; book < 5; book++) {
          box(['teal', 'gold', 'pink', 'hq-text', 'accent'][book], x + 4 + book * 5, y + 5 + shelf * 24, 3, 17 - (book % 3));
          box('hq-gold-2', x + 4 + book * 5, y + 10 + shelf * 24, 2, 1);
        }
        box('hq-gold', x, y + 23 + shelf * 24, 31, 3);
      }
    }
    if (room.kind === 'lounge') {
      box('hq-chair-body', room.x0 + 10, f.y + 28, 67, 34);
      box('accent', room.x0 + 13, f.y + 31, 61, 28);
      box('hq-plate', room.x0 + 16, f.y + 34, 55, 22);
    }
  }

  // ---------- labels and icons ----------
  plate(text, x, y, color = this.palette['hq-text'], size = 12) {
    const c = this.ctx;
    c.font = `${size}px ${FONT}`;
    const width = c.measureText(text).width + 12;
    c.fillStyle = this.palette['hq-plate'];
    c.fillRect(x - width / 2, y - 15, width, 20);
    c.fillStyle = color;
    c.fillText(text, x - width / 2 + 6, y);
  }

  pixelIcon(cat, x, y) {
    const c = this.ctx;
    c.fillStyle = this.palette['hq-plate'];
    c.fillRect(x - 18, y - 18, 36, 36);
    c.fillStyle = this.palette['hq-gold'];
    (PIXELS[cat] || PIXELS.other).forEach((row, j) => [...row].forEach((bit, i) => bit === '1' && c.fillRect(x - 14 + i * 2, y - 10 + j * 2, 2, 2)));
  }

  // ---------- actors ----------
  drawActivityCell(p, row, frame, height) {
    const sheet = this.assets.activities;
    const crop = ACTIVITY_ROWS[row];
    const cellWidth = sheet.width / 4;
    const sourceHeight = crop.bottom - crop.top;
    const width = (height * cellWidth) / sourceHeight;
    this.ctx.drawImage(sheet, frame * cellWidth, crop.top, cellWidth, sourceHeight, p.x - width / 2, p.y - height, width, height);
  }

  // From behind, at a computer (hq-rear.png: four typing frames, a person above, a robot below)
  drawRear(p, robot, frame, height) {
    const sheet = this.assets.rear;
    const cellW = sheet.width / 4;
    const cellH = sheet.height / 2;
    const crop = { x: cellW * 0.16, y: cellH * 0.06, w: cellW * 0.68, h: cellH * 0.89 };
    const width = (height * crop.w) / crop.h;
    this.ctx.drawImage(sheet, frame * cellW + crop.x, (robot ? cellH : 0) + crop.y, crop.w, crop.h, p.x - width / 2, p.y - height, width, height);
  }

  // An actor at its seat: the pose fits the furniture (from behind at a computer, standing at a rack or an easel,
  // reading in the library, facing out while it waits or rests)
  drawRoomActor(a, p, pose, time) {
    const c = this.ctx;
    const robot = a.kind === 'agent';
    const front = a.furniture.facing === 'front' || a.state === 'waiting' || a.state === 'left';
    const still = this.view.still;
    const frame = still ? 0 : Math.floor(time / 170) % 4;
    const typing = a.state === 'busy';
    const rest = a.state === 'left';
    const wave = a.state === 'waiting';
    const shift = typing && frame % 2 ? 1 : 0;
    const px = (color, x, y, w, h) => this.box(c, color, p.x + x, p.y + y, w, h);
    if (a.furniture.activity === 'desk') {
      if (this.assets.rear) {
        const seating = pose.sheet === 'move' && pose.frame >= 4 && pose.frame <= 7 ? (7 - pose.frame) / 3 : 0;
        this.drawRear(p, robot, frame, 78 + seating * 5);
      } else {
        // From behind without the sheet: the same desk geometry
        px(robot ? 'hq-metal' : 'hq-person-shirt', -14, -53, 28, 30);
        px(robot ? 'hq-metal' : 'hq-person-hair', -11, -76, 22, 22);
        px(robot ? 'hq-metal-dark' : 'hq-skin-shade', -5, -56, 10, 5);
        px(robot ? 'hq-metal' : 'hq-person-shirt', -21, -48, 8, 10);
        px(robot ? 'hq-metal' : 'hq-person-shirt', 13, -48, 8, 10);
        px('hq-chair-body', -17, -44, 34, 34);
        px('hq-line', -15, -42, 30, 2);
        px('hq-metal-dark', -3, -10, 6, 9);
        px('hq-metal-dark', -19, -3, 38, 3);
      }
      return;
    }
    if ((a.furniture.activity === 'rack' || a.furniture.activity === 'draw' || a.furniture.activity === 'read') && this.assets.activities) {
      const standing = a.furniture.posture === 'standing';
      const row = standing ? (robot ? 0 : 1) : robot ? 3 : 2;
      const activityFrame = still ? 0 : Math.floor(time / (standing ? 700 : 1100)) % 4;
      this.drawActivityCell(p, row, activityFrame, standing ? 84 : 64);
      if (a.furniture.activity === 'draw') {
        px('hq-gold', 18, -50, 2, 10);
        px('hq-text', 20, -49, 10, 2);
      }
      if (a.furniture.activity === 'rack' && (activityFrame === 1 || activityFrame === 2)) {
        // a hand on the rack, and its lights answer
        px('hq-metal-dark', 11, -51, 6, 5);
        px('hq-metal', 15, -50, 13, 4);
        px('hq-metal-dark', 26, -52, 4, 7);
        const point = a.furniture.screenPoint;
        c.save();
        c.globalAlpha *= 0.5;
        c.fillStyle = this.palette['hq-flash'];
        c.fillRect(point.x, point.y - 11, 4, 4);
        c.fillRect(point.x, point.y - 4, 4, 3);
        c.restore();
      }
      return;
    }
    // A standing post never falls back to a seated pose with a chair
    if (a.furniture.posture === 'standing' && this.assets[robot ? 'robot' : 'person']) {
      const r = moveCellRect({ x: p.x - 43, y: p.y - 86, w: 86, h: 86 }, robot ? 'robot' : 'person');
      c.drawImage(this.assets[robot ? 'robot' : 'person'], 512, 768, 256, 384, r.x, r.y, r.w, r.h);
      return;
    }
    if (!front && this.assets.rear) {
      this.drawRear(p, robot, frame, 78);
      return;
    }
    if (front && this.assets[robot ? 'robot' : 'person']) {
      const r = moveCellRect({ x: p.x - 43, y: p.y - 86, w: 86, h: 86 }, robot ? 'robot' : 'person');
      const cell = wave || rest ? pose.frame : 0;
      c.drawImage(this.assets[robot ? 'robot' : 'person'], (cell % 4) * 256, Math.floor(cell / 4) * 384, 256, 384, r.x, r.y, r.w, r.h);
      if (a.room.kind === 'library') {
        px('hq-gold', -8, -30, 18, 10);
        px('hq-text', -6, -28, 14, 6);
        px('hq-gold', 0, -28, 2, 7);
      }
      return;
    }
    // Without the sheets: a figure drawn in code
    c.save();
    if (pose.sheet === 'move' && pose.frame >= 4 && pose.frame <= 7) c.translate(0, -((7 - pose.frame) / 3) * 14);
    if (robot) {
      px('hq-metal-dark', -10, -39, 20, 22);
      px('hq-metal', -11, -48, 22, 24);
      px('hq-metal-dark', -12, -64, 24, 18);
      px('hq-metal', -11, -69, 22, 18);
      px('hq-metal', -8, -72, 16, 5);
      px('hq-metal-dark', -5, -53, 10, 5);
      if (front) {
        px('hq-chair-body', -9, -66, 18, 9);
        px('accent', -6, -63, 4, 3);
        px('accent', 3, -63, 4, 3);
      } else {
        px('hq-metal-dark', -8, -66, 16, 3);
        px('accent', -3, -65, 6, 2);
        px('hq-metal-dark', -3, -57, 6, 3);
      }
      px('hq-metal-dark', -7, -38, 14, 12);
      px('gold', -10, -43, 4, 4);
      px('gold', 6, -43, 4, 4);
    } else {
      px('hq-person-shirt', -13, -47, 26, 29);
      px('hq-skin-shade', -4, -54, 8, 9);
      px('hq-skin', -9, -68, 18, 17);
      px('hq-person-hair', -10, -72, 20, 7);
      px('hq-person-hair', -11, -68, 22, 5);
      if (front) {
        px('hq-person-hair', -9, -66, 3, 7);
        px('hq-person-hair', 7, -66, 3, 7);
        px('hq-shade', -5, -61, 2, 2);
        px('hq-shade', 4, -61, 2, 2);
        px('hq-skin-shade', -2, -56, 5, 2);
      } else {
        px('hq-person-hair', -10, -66, 20, 10);
        px('hq-skin-shade', -11, -62, 2, 5);
        px('hq-skin-shade', 10, -62, 2, 5);
        px('hq-person-shirt', -1, -46, 2, 23);
      }
    }
    const arm = robot ? 'hq-metal' : 'hq-person-shirt';
    const hand = robot ? 'hq-metal-dark' : 'hq-skin';
    if (wave) {
      const up = still || pose.frame >= 2;
      px(arm, -17, -45, 6, 20);
      px(hand, -17, -27, 6, 5);
      px(arm, 12, -48, 6, 17);
      px(arm, up ? 17 : 16, up ? -70 : -51, 6, up ? 27 : 13);
      px(hand, up ? 17 : 16, up ? -77 : -57, 6, 8);
    } else if (rest) {
      px(arm, -18, -45, 6, 21);
      px(arm, 12, -45, 6, 21);
      px(hand, -18, -26, 6, 5);
      px(hand, 12, -26, 6, 5);
      if (pose.frame === 13 || pose.frame === 14) {
        px(hand, 10, -41, 6, 10);
        px('hq-text', 13, -39, 7, 8);
      }
    } else if (front) {
      px(arm, -18, -44, 6, 18);
      px(arm, 12, -44, 6, 18);
      px(hand, -17, -28, 7, 5);
      px(hand, 10, -28, 7, 5);
      if (a.room.kind === 'library') {
        px('hq-gold', -12, -33, 24, 12);
        px('hq-text', -10, -31, 20, 7);
        px('hq-gold', -1, -31, 2, 8);
      }
    } else {
      px(arm, -18, -44, 7, 14);
      px(arm, 11, -44, 7, 14);
      px(hand, -18, -34 + shift, 12, 5);
      px(hand, 6, -34 - shift, 12, 5);
    }
    px('hq-metal-dark', -10, -17, 8, 15);
    px('hq-metal-dark', 3, -17, 8, 15);
    px(robot ? 'hq-metal' : 'hq-shoe', -13, -4, 12, 4);
    px(robot ? 'hq-metal' : 'hq-shoe', 3, -4, 12, 4);
    if (!front && a.room.kind !== 'server') {
      px('hq-chair-body', -12, -35, 24, 19);
      px('hq-metal-dark', -10, -35, 20, 2);
      px('hq-chair-body', -15, -17, 30, 4);
      px('hq-metal-dark', -2, -13, 4, 9);
      px('hq-chair-body', -14, -3, 28, 3);
    }
    c.restore();
  }

  // The doors: closed, or open while someone walks through (or the person opened it); the open leaves are drawn again
  // over the actors so whoever passes walks behind the frame
  drawDoors(scene, foreground = false) {
    const c = this.ctx;
    for (const door of scene.doors) {
      const open = door.open || this.view.manualDoors.has(door.id);
      const x = door.x - 12;
      const y = door.y - 95;
      if (foreground) {
        if (open) {
          this.box(c, 'accent', x + 1, y + 3, 3, 88);
          this.box(c, 'hq-line', x + 24, y + 3, 3, 88);
        }
        continue;
      }
      this.box(c, 'hq-metal-dark', x, y, 27, 95);
      this.box(c, 'hq-plate', x + 4, y + 4, 19, 91);
      if (!open) {
        this.box(c, 'hq-line', x + 6, y + 6, 15, 87);
        this.box(c, 'accent', x + 9, y + 11, 9, 47);
        this.box(c, 'hq-gold', x + 18, y + 67, 3, 3);
      } else {
        this.box(c, 'accent', x + 1, y + 3, 3, 88);
        this.box(c, 'hq-line', x + 24, y + 3, 3, 88);
      }
      if (this.view.hover === door.id) {
        c.strokeStyle = this.palette['hq-focus'];
        c.lineWidth = 2;
        c.strokeRect(x - 3, y - 3, 33, 101);
      }
    }
  }

  // The front edge of a desk or a table in front of the actor sitting at it
  drawDeskEdge(a) {
    if (!a.furniture.desk || a.furniture.activity === 'desk') return;
    const { x, deskY } = a.furniture;
    this.box(this.ctx, 'hq-gold', x + 18, deskY + 2, 79, 4);
    this.box(this.ctx, 'hq-gold-2', x + 18, deskY + 2, 79, 1);
  }

  // ---------- the frame ----------
  draw(scene, time) {
    if (!scene || !this.cv.width) return;
    const c = this.ctx;
    const v = this.view;
    const p = this.palette;
    const tf = this.transform();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = p['hq-bg'];
    c.fillRect(0, 0, this.cv.width, this.cv.height);
    c.imageSmoothingEnabled = false;
    c.save();
    c.beginPath();
    c.rect(tf.ox, tf.oy, tf.w * tf.k, tf.h * tf.k);
    c.clip();
    c.setTransform(tf.k, 0, 0, tf.k, tf.ox - tf.x * tf.k, tf.oy - tf.y * tf.k);
    c.globalAlpha = scene.closed ? 0.35 : 1;
    c.drawImage(this.cachedBuilding(), 0, 0);
    c.globalAlpha = 1;
    this.plate(this.word('brand'), 730, 146, p.accent, 30);
    // The job's four lamps under the sign: Plan, Build, Check, Finish (done green, now yellow, ahead dark)
    jobLamps(scene.job).forEach((st, i) => {
      const x = 679 + i * 34;
      c.beginPath();
      c.arc(x, 186, 8, 0, Math.PI * 2);
      c.fillStyle = st === 'done' ? p.busy : st === 'now' ? p.idle : p['hq-plate'];
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = p['hq-line'];
      c.stroke();
    });
    if (v.hover === 'lift') {
      c.strokeStyle = p['hq-focus'];
      c.lineWidth = 3;
      c.strokeRect(LIFT_BOX.x, LIFT_BOX.y, LIFT_BOX.w, LIFT_BOX.h);
    }
    // the room or the seat under the pointer, or chosen
    const sel = v.selected;
    for (const room of ROOMS) {
      const f = FLOORS[room.floor];
      if (v.hover !== `room:${room.id}` && !(sel?.kind === 'room' && sel.id === room.id)) continue;
      c.save();
      c.globalAlpha = 0.08;
      c.fillStyle = p['hq-hover'];
      c.fillRect(room.x0, f.y, room.x1 - room.x0, f.h);
      c.restore();
      c.strokeStyle = p['hq-focus'];
      c.lineWidth = 2;
      c.strokeRect(room.x0, f.y, room.x1 - room.x0, f.h);
    }
    for (const fx of scene.fixtures) {
      if (v.hover !== fx.id && !(sel?.kind === 'fixture' && sel.id === fx.id)) continue;
      c.strokeStyle = p['hq-focus'];
      c.lineWidth = 2;
      c.strokeRect(fx.x0, fx.y0, fx.x1 - fx.x0, fx.y1 - fx.y0);
    }
    // the lift's cabin with whoever rides it
    for (const a of scene.actors) {
      if (v.still || a.mobility !== 'lift' || a.travel >= 1) continue;
      c.save();
      c.globalAlpha = 0.6;
      this.box(c, 'hq-plate', LIFT_BOX.x + 3, a.y - 98, 75, 99);
      c.restore();
      c.strokeStyle = p.accent;
      c.lineWidth = 2;
      c.strokeRect(LIFT_BOX.x + 3, a.y - 98, 75, 99);
    }
    this.drawDoors(scene);
    const byId = new Map(scene.actors.map((a) => [a.id, a]));
    // "Highlight team": the others fade
    const alpha = (a) => (v.highlight && a.sessionId !== v.highlight ? 0.22 : 1);
    // the links: who started whom
    for (const link of scene.links) {
      const a = byId.get(link.from);
      const b = byId.get(link.to);
      if (!a || !b || (v.still && (a.goneAt != null || b.goneAt != null))) continue;
      const from = this.position(a);
      const to = this.position(b);
      c.globalAlpha = link.alpha * 0.85 * Math.min(alpha(a), alpha(b));
      c.setLineDash(link.background ? [6, 6] : []);
      c.beginPath();
      c.moveTo(from.x + 28, from.y - 45);
      c.lineTo(to.x + 28, to.y - 45);
      c.strokeStyle = p['hq-shade'];
      c.lineWidth = 4;
      c.stroke();
      c.strokeStyle = this.actorColor(link.colorOwner);
      c.lineWidth = 2;
      c.stroke();
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
    // the room names and "+N"
    for (const room of ROOMS) {
      const f = FLOORS[room.floor];
      if (v.floor != null && v.floor !== room.floor) continue;
      this.plate(this.word(room.kind), room.x0 + 55, f.y + 17, p['hq-gold'], 11);
      if (scene.more[room.id]) this.plate(this.word('overflow', { n: scene.more[room.id] }), room.x1 - 60, f.feet - 12);
    }
    const shown = (a) => !(v.floor != null && a.room.floor !== v.floor && a.travel === 1) && !(v.still && a.goneAt != null);
    for (const a of scene.actors) {
      if (!shown(a)) continue;
      const at = this.position(a);
      const who = a.kind === 'agent' ? 'robot' : 'person';
      const r = { x: at.x - 43, y: at.y - 86, w: 86, h: 86 };
      const pose = v.still ? actorPose({ state: a.state, time, still: true }) : a.pose;
      c.globalAlpha = pose.alpha * alpha(a);
      const seated = (v.still || a.travel === 1) && a.goneAt == null;
      if (seated) {
        if (a.furniture.screen && scene.icons.some((i) => i.id === a.id)) {
          // a tool call lights the screen
          const s = a.furniture.screenPoint;
          c.save();
          c.globalAlpha *= 0.22;
          c.fillStyle = p['hq-flash'];
          c.fillRect(s.x - 13, s.y - 12, 26, 15);
          c.restore();
        }
        this.drawRoomActor(a, at, pose, time);
        this.drawDeskEdge(a);
      } else if (this.assets.activities && pose.sheet === 'move' && pose.frame >= 8 && pose.frame <= 10) {
        this.drawActivityCell(at, who === 'robot' ? 0 : 1, 0, 72 + (pose.frame - 8) * 6);
      } else if (pose.sheet === 'type' && this.assets.actors) {
        const sheet = this.assets.actors;
        const cw = sheet.width / 4;
        const ch = sheet.height / 2;
        c.drawImage(sheet, pose.frame * cw, who === 'robot' ? ch : 0, cw, ch, r.x, r.y, r.w, r.h);
      } else if (this.assets[who]) {
        const dest = moveCellRect(r, who);
        c.save();
        if (pose.frame === 11 && a.walkFlip) {
          c.translate(2 * at.x, 0);
          c.scale(-1, 1);
        }
        c.drawImage(this.assets[who], (pose.frame % 4) * 256, Math.floor(pose.frame / 4) * 384, 256, 384, dest.x, dest.y, dest.w, dest.h);
        c.restore();
      } else {
        c.fillStyle = a.kind === 'agent' ? p['hq-text'] : p.accent;
        c.fillRect(at.x - 12, at.y - 45, 24, 35);
        c.fillStyle = p['hq-gold'];
        c.fillRect(at.x - 9, at.y - 65, 18, 18);
        c.fillStyle = p['hq-shade'];
        c.fillRect(at.x - 8, at.y - 7, 6, 7);
        c.fillRect(at.x + 2, at.y - 7, 6, 7);
        if (a.state === 'waiting') c.fillRect(at.x + 15, at.y - 78, 5, 38);
      }
      if (a.state === 'waiting') {
        // the "!" and its ring, growing and fading
        c.strokeStyle = p.idle;
        c.lineWidth = 2;
        const radius = v.still ? 15 : 12 + waitRing(time) * 15;
        c.beginPath();
        c.arc(at.x + 25, at.y - 70, radius, 0, Math.PI * 2);
        c.stroke();
        this.plate('!', at.x + 25, at.y - 66, p.idle, 18);
      }
      if (v.focus === a.id || v.eventActor === a.id) {
        c.strokeStyle = p['hq-focus'];
        c.lineWidth = 3;
        c.strokeRect(at.x - 46, at.y - 95, 92, 136);
      }
    }
    c.globalAlpha = 1;
    this.drawDoors(scene, true);
    // names, models and workflow badges under and over the actors
    for (const a of scene.actors) {
      if (!shown(a)) continue;
      const at = this.position(a);
      c.globalAlpha = a.pose.alpha * alpha(a);
      this.plate(a.title || '', at.x, at.y + 15, this.actorColor(`s:${a.sessionId ?? a.id}`), 11);
      if (a.model) this.plate(a.model, at.x, at.y + 35, p['hq-note-text'], 10);
      const wf = a.a?.workflowRunId && scene.workflows.find((w) => w.id === a.a.workflowRunId);
      if (wf?.name) this.plate(wf.name, at.x, at.y - 83, p['hq-gold'], 9);
    }
    c.globalAlpha = 1;
    if (!v.still) {
      // the task and result cards on their way, and the lead's screen as a result arrives
      for (const card of scene.cards) {
        const x = lerp(card.from.x, card.to.x, card.p);
        const y = lerp(card.from.y - 45, card.to.y - 45, card.p);
        c.fillStyle = this.actorColor(card.owner);
        c.fillRect(x - 9, y - 7, 18, 14);
        c.fillStyle = p['hq-plate'];
        c.fillRect(x - 6, y - 3, 12, 2);
        c.fillRect(x - 6, y + 1, 9, 2);
      }
      for (const flash of scene.flashes) {
        const a = byId.get(flash.id);
        if (!a) continue;
        c.globalAlpha = flash.strength;
        c.fillStyle = p['hq-flash'];
        c.fillRect(a.furniture.screenPoint.x - 14, a.furniture.screenPoint.y - 13, 28, 20);
      }
      c.globalAlpha = 1;
    }
    // A job just given (docs/simplify.md): its card rides from the lobby up the lift to the main room's desk
    if (v.jobCard && !v.still) {
      const p = (Date.now() - v.jobCard.at) / JOB_CARD_MS;
      if (p >= 0 && p < 1) {
        const room = ROOMS.find((r) => r.kind === baseKind(scene.project.mainRoomKind || 'dev')) || ROOMS[2];
        const route = walkingRoute({ x: LIFT_X, y: FLOORS[FLOORS.length - 1].feet }, { x: room.seats[0], y: FLOORS[room.floor].feet });
        const at = routePosition(route, p);
        c.fillStyle = this.palette.accent;
        c.fillRect(at.x - 11, at.y - 60, 22, 16);
        c.fillStyle = this.palette['hq-plate'];
        c.fillRect(at.x - 7, at.y - 55, 14, 2);
        c.fillRect(at.x - 7, at.y - 51, 10, 2);
      } else if (p >= 1) v.jobCard = null;
    }
    // A plan waiting for approval, or a result ready, beside its lead: a sheet that glows
    for (const [id, color] of [[scene.planPending, p.idle], [scene.resultReady, p.busy]]) {
      const a = id && byId.get(id);
      if (!a || !shown(a)) continue;
      const at = this.position(a);
      const glow = v.still ? 0.6 : 0.45 + 0.35 * Math.sin(time / 300);
      c.save();
      c.globalAlpha = glow * 0.5;
      c.fillStyle = color;
      c.fillRect(at.x + 30, at.y - 70, 30, 36);
      c.globalAlpha = 1;
      c.fillStyle = p['hq-text'];
      c.fillRect(at.x + 34, at.y - 66, 22, 28);
      c.fillStyle = color;
      for (let k = 0; k < 4; k++) c.fillRect(at.x + 37, at.y - 61 + k * 6, 16 - (k % 2) * 5, 2);
      c.restore();
    }
    for (const icon of scene.icons) {
      const a = byId.get(icon.id);
      if (!a || !shown(a)) continue;
      const at = this.position(a);
      this.pixelIcon(icon.cat, at.x, at.y - 116);
      if (icon.count > 1) this.plate(`×${icon.count}`, at.x + 28, at.y - 108, p['hq-gold'], 11);
    }
    c.restore();
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  destroy() {
    this.dead = true;
    this.buffer = null;
  }
}

