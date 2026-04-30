import fs from 'node:fs/promises';
import path from 'node:path';

export class TaskStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'tasks.json');
    this.tasks = new Map();
    this.ready = this.load();
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const list = JSON.parse(content);
      for (const task of list) {
        this.tasks.set(task.id, task);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async save() {
    await this.ready;
    const list = Array.from(this.tasks.values()).sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    await fs.writeFile(this.filePath, JSON.stringify(list, null, 2));
  }

  async create(task) {
    await this.ready;
    this.tasks.set(task.id, task);
    await this.save();
    return task;
  }

  async update(id, patch) {
    await this.ready;
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }
    const next = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.tasks.set(id, next);
    await this.save();
    return next;
  }

  async get(id) {
    await this.ready;
    return this.tasks.get(id) || null;
  }

  async list(limit = 30) {
    await this.ready;
    return Array.from(this.tasks.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }
}
