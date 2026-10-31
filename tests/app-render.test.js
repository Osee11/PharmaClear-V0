'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.hidden = false;
    this.className = '';
    this.textContent = '';
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
}

test('a completed mock result renders without a network response object', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function renderResult(');
  const end = source.indexOf('\nasync function showResult(', start);
  assert.notEqual(start, -1, 'renderResult should exist');
  assert.ok(end > start, 'renderResult should have a function boundary');

  const elements = new Map(
    ['result-content', 'sample-banner', 'mock-banner'].map((id) => [id, new FakeElement()]),
  );
  const context = {
    language: 'en',
    $: (id) => elements.get(id),
    show: (id, visible) => { elements.get(id).hidden = !visible; },
    makeElement: (tag, className, text) => {
      const element = new FakeElement(tag);
      element.className = className || '';
      if (text !== undefined) element.textContent = text;
      return element;
    },
    addField: () => {},
    safeSourceLink: () => null,
    t: (key, values = {}) => key.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')),
    document: {
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => ({ textContent: text }),
    },
  };
  const renderer = source.slice(start, end);

  assert.doesNotThrow(() => vm.runInNewContext(
    `${renderer}\nrenderResult({` +
      `status:'success - MOCK', ` +
      `detected_drugs:[{name:'SAMPLE-ONLY-A'}], ` +
      `uncertain:[{name:'SAMPLE-ONLY-UNCERTAIN'}], ` +
      `interactions:[{status:'not_verified'}]` +
    `});`,
    context,
  ));
  assert.equal(elements.get('result-content').children.length, 1);
  assert.equal(elements.get('mock-banner').hidden, false);
});
