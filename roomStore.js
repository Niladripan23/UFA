'use strict';
const { createClient } = require('redis');

// Compare-and-set protects against stale writes, including overlapping Render deploys.
const WRITE = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if cjson.decode(current).version ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;
const DELETE = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if cjson.decode(current).version ~= tonumber(ARGV[1]) then return -1 end
return redis.call('DEL', KEYS[1])`;

class RoomStore {
  constructor(url, prefix = 'ufa:v1:room:') {
    this.prefix = prefix;
    this.client = createClient({ url, disableOfflineQueue: true, commandOptions: { timeout: 5000 },
      socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(250 * (retries + 1), 3000) } });
    this.client.on('error', () => console.error('Redis unavailable; room mutations are blocked until storage recovers.'));
  }
  async connect() {
    let timeout;
    try {
      await Promise.race([this.client.connect(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis startup connection timed out. Check REDIS_URL and network access.')), 10000);
      })]);
      await this.client.ping();
    } catch (error) { this.close(); throw error; }
    finally { clearTimeout(timeout); }
  }
  isReady() { return this.client.isReady; }
  async ping() { return this.client.ping(); }
  async getRoom(code) {
    const value = await this.client.get(this.prefix + code);
    return value ? JSON.parse(value) : null;
  }
  async createRoom(room) {
    room.version = 1;
    return (await this.client.set(this.prefix + room.code, JSON.stringify(room), { NX: true, PX: this.ttl(room) })) === 'OK';
  }
  ttl(room) { return Math.max(1, room.expiresAt - Date.now()); }
  async saveRoom(room) {
    const next = { ...room, version: room.version + 1 };
    const result = await this.client.eval(WRITE, { keys: [this.prefix + room.code], arguments: [String(room.version), JSON.stringify(next), String(this.ttl(room))] });
    if (result !== 1) throw Object.assign(new Error('Room changed or expired; retry the action.'), { code: 'ROOM_CONFLICT' });
    room.version = next.version;
  }
  async deleteRoom(room) {
    const result = await this.client.eval(DELETE, { keys: [this.prefix + room.code], arguments: [String(room.version)] });
    if (result === -1) throw Object.assign(new Error('Room changed; retry the action.'), { code: 'ROOM_CONFLICT' });
  }
  async listActiveRooms() {
    const codes = [];
    for await (const keys of this.client.scanIterator({ MATCH: this.prefix + '*', COUNT: 100 })) {
      for (const key of keys) codes.push(key.slice(this.prefix.length));
    }
    return codes;
  }
  close() { if (this.client.isOpen) this.client.destroy(); }
}

module.exports = { RoomStore };
