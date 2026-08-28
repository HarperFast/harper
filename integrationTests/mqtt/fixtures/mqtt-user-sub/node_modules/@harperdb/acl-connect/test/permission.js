import { describe, it } from 'node:test';
import { mqttPermissionCheck, resolveTopic } from '../permission.js';
import assert from "node:assert";

describe('Test mqttPermissionCheck', () => {

  it('test liberty/scott/# expect false', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/scott expect false', () => {
    let result = mqttPermissionCheck(['liberty', 'scott'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/# expect false', () => {
    let result = mqttPermissionCheck(['liberty', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/bill/+ expect false', () => {
    let result = mqttPermissionCheck(['liberty', 'bill', '+'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/scott/+ expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', '+'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/scott/+/tmp expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', '+', 'tmp'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test liberty/scott/hi/tmp expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', 'hi', 'tmp'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test liberty/scott/hi/tmp/bad expect false', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', 'hi', 'tmp', 'bad'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/scott/tmp expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'scott', 'tmp'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/testing/# expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'testing', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test liberty/# expect false', () => {
    let result = mqttPermissionCheck(['liberty', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

  it('test liberty/testing/cool expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'testing', 'cool'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test liberty/testing/cool/cooler/coolest expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'testing', 'cool', 'cooler', 'coolest'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test liberty/testing/cool/# expect true', () => {
    let result = mqttPermissionCheck(['liberty', 'testing', 'cool', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, true);
  });

  it('test nogood/testing/cool/# expect false', () => {
    let result = mqttPermissionCheck(['nogood', 'testing', 'cool', '#'], [['liberty', 'scott', '+', '+'], ['liberty', 'testing', '#']]);
    assert.equal(result, false);
  });

});


describe('Test resolveTopic', () => {
  it("test ('events', ['a/b']) => ['events', 'a', 'b']", () => {
    let result = resolveTopic('events', ['a/b']);
    assert.deepStrictEqual(result, ['events', 'a', 'b']);
  });
  it("test ('events', ['a','b']) => ['events', 'a', 'b']", () => {
    let result = resolveTopic('events', ['a', 'b']);
    assert.deepStrictEqual(result, ['events', 'a', 'b']);
  });
})