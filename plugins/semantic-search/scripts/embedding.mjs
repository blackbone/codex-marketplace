import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cacheDir, privateDir, withLock, atomicJson, MODEL, MODEL_KEY, REVISION, TRANSFORMERS_VERSION } from './common.mjs';

const exec = promisify(execFile);
let loaded;
let inference = Promise.resolve();

async function runtime() {
  const base = cacheDir('runtime');
  const target = path.join(base, `transformers-${TRANSFORMERS_VERSION}-${process.platform}-${process.arch}`);
  const marker = path.join(target, '.complete.json');
  await withLock(path.join(base, 'install.lock'), async () => {
    if (fs.existsSync(marker)) return;
    const stage = `${target}.partial`;
    fs.rmSync(stage, { recursive: true, force: true });
    privateDir(stage);
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@huggingface/transformers': TRANSFORMERS_VERSION } }));
    try {
      await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cacheDir('npm-cache')], {
        cwd: stage, timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_cache: cacheDir('npm-cache') },
      });
      atomicJson(path.join(stage, '.complete.json'), { version: TRANSFORMERS_VERSION });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(stage, target);
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw new Error(`Embedding runtime setup failed (Node.js 22.13+ and npm required): ${e.message}`);
    }
  });
  return import(pathToFileURL(path.join(target, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
}

export async function getEmbedder() {
  if (!loaded) loaded = load().catch(error => { loaded = undefined; throw error; });
  return loaded;
}

async function load() {
  const { pipeline, env } = await runtime();
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  const models = cacheDir('models');
  env.localModelPath = models;
  const target = path.join(models, MODEL_KEY);
  const options = { revision: REVISION, dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } };
  const pipe = await withLock(path.join(models, `${MODEL_KEY}.lock`), async () => {
    if (fs.existsSync(path.join(target, '.complete.json'))) {
      env.cacheDir = target;
      return pipeline('feature-extraction', MODEL, { ...options, cache_dir: target, local_files_only: true });
    }
    const stage = `${target}.partial`;
    fs.rmSync(stage, { recursive: true, force: true });
    privateDir(stage);
    env.cacheDir = stage;
    try {
      const result = await pipeline('feature-extraction', MODEL, { ...options, cache_dir: stage });
      atomicJson(path.join(stage, '.complete.json'), { model: MODEL, revision: REVISION, dtype: 'q8' });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(stage, target);
      env.cacheDir = target;
      return result;
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw new Error(`Model download/load failed: ${e.message}`);
    }
  });
  return {
    model: MODEL, revision: REVISION,
    tokenCount: text => pipe.tokenizer.encode(text).length,
    embed(texts) {
      const work = inference.then(async () => {
        const vectors = [];
        for (let i = 0; i < texts.length; i += 8) {
          const tensor = await pipe(texts.slice(i, i + 8), { pooling: 'mean', normalize: true });
          vectors.push(...tensor.tolist());
        }
        return vectors;
      });
      inference = work.catch(() => {});
      return work;
    },
  };
}
