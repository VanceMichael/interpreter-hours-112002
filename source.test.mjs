import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { start } from './source-server.mjs';

const read = async (name) => JSON.parse(await readFile(new URL(`source-data/${name}.json`, import.meta.url), 'utf8'));

test('资料在指定回放阶段从来源完整分页返回', async (t) => {
  const index = await read('index');
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const overview = await (await fetch(url)).json();
  assert.deepEqual(overview.sources, index.sources);
  assert.equal(overview.stage, 1);
  const expectedRecords = new Map();
  for (const name of index.sources) {
    const records = await read(name);
    assert.ok(records.length > 0);
    assert.equal(new Set(records.map((entry) => entry.record)).size, records.length);
    expectedRecords.set(name, records);
  }
  for (let stage = 1; stage <= index.stages; stage += 1) {
    const control = await fetch(`${url}/control?stage=${stage}`, { method: 'POST' });
    assert.equal(control.status, 200);
    for (const name of index.sources) {
      const collected = [];
      let offset = 0;
      do {
        const response = await fetch(`${url}/source/${name}?offset=${offset}&limit=2`);
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.stage, stage);
        assert.ok(page.records.length <= 2);
        assert.ok(page.next === null || page.next > offset);
        collected.push(...page.records);
        offset = page.next;
      } while (offset !== null);
      assert.deepEqual(collected, expectedRecords.get(name).filter((entry) => entry.availableFrom <= stage));
    }
    for (const name of index.originals) {
      const response = await fetch(`${url}/original/${name}`);
      if (stage >= (index.originalStages[name] ?? 1)) {
        assert.equal(response.status, 200);
        const bytes = await response.arrayBuffer();
        assert.equal(createHash('sha256').update(Buffer.from(bytes)).digest('hex'), index.digests[name]);
      } else {
        assert.equal(response.status, 404);
      }
    }
  }
  assert.equal((await fetch(`${url}/control?stage=0`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${url}/source/${index.sources[0]}?limit=0`)).status, 400);
  assert.equal((await fetch(`${url}/source/missing`)).status, 404);
  t.diagnostic(`${index.sources.length} 处来源、${index.stages} 个阶段、${index.originals.length} 份原件`);
});

test('已核销的修订和另一项尚未确证分别可查询', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await fetch(url + '/control?stage=3', { method: 'POST' });
  const approved = await (await fetch(url + '/posting/K81')).json();
  assert.deepEqual(approved.item.billed, ['10:10','10:24']);
  assert.deepEqual(approved.adjustment.payable, ['10:12','10:24']);
  assert.equal((await fetch(url + '/posting/K82')).status, 202);
  await fetch(url + '/control?stage=4', { method: 'POST' });
  assert.equal((await (await fetch(url + '/posting/K82')).json()).item.status, '明确未入账');
});
