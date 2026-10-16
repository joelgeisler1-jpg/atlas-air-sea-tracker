'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {wrapLongitude,longitudeNear,splitViewport,unwrapTrail}=require('../target-model');
const {validateBoundingBoxes}=require('../backend/lib');

test('longitude wrapping is canonical at boundaries and through repeated worlds',()=>{
  for(const [input,expected] of [[180,-180],[-180,-180],[540,-180],[-540,-180],[190,-170],[370,10],[-190,170],[1081,1],[-1081,-1],[0,0]])assert.equal(wrapLongitude(input),expected);
  assert.ok(Number.isNaN(wrapLongitude(NaN)));assert.ok(Number.isNaN(wrapLongitude(Infinity)));
});

test('normal and repeated-world marine boxes normalize without increasing their area',()=>{
  assert.deepEqual(splitViewport([-35,138,-34,139]),[[-35,138,-34,139]]);
  assert.deepEqual(splitViewport([-35,498,-34,499]),[[-35,138,-34,139]]);
  assert.deepEqual(splitViewport([-35,-222,-34,-221]),[[-35,138,-34,139]]);
  assert.deepEqual(splitViewport([-1,180,1,182]),[[-1,-180,1,-178]]);
  assert.deepEqual(splitViewport([-1,178,1,180]),[[-1,178,1,180]]);
});

test('date-line viewports split into two small boxes with the original total constraints',()=>{
  const boxes=[[-1,179,1,180],[-1,-180,1,-179]];
  for(const offset of [-720,-360,0,360,720])assert.deepEqual(splitViewport([-1,179+offset,1,181+offset]),boxes);
  assert.deepEqual(validateBoundingBoxes(boxes),boxes);
  assert.equal(splitViewport([-1,170,1,190]),null);
  assert.equal(splitViewport([-9,179,1,181]),null);
  assert.equal(validateBoundingBoxes([[-1,170,1,180],[-1,-180,1,-170]]),null);
  assert.equal(validateBoundingBoxes([[-1,179,1,180],[-2,-180,1,-179]]),null);
  assert.equal(validateBoundingBoxes([[-1,170,1,172],[-1,173,1,175]]),null);
  assert.equal(validateBoundingBoxes([boxes[0],boxes[0],boxes[1]]),null);
});

test('targets and trails use the nearest visible world without long date-line segments',()=>{
  assert.equal(longitudeNear(-179.9,180.1),180.1);
  assert.equal(longitudeNear(179.9,-180.1),-180.1);
  assert.equal(longitudeNear(138.5,498.5),498.5);
  const points=[[0,179.9,1],[0,-179.9,2],[0,-179.8,3]];
  const trail=unwrapTrail(points,540.2);
  assert.ok(Math.abs(trail[1][1]-trail[0][1])<0.21);assert.ok(Math.abs(trail[2][1]-540.2)<1e-8);
  assert.equal(points[0][1],179.9);
  const reverse=unwrapTrail([[0,-179.9],[0,179.9]],-180.1);
  assert.ok(Math.abs(reverse[1][1]-reverse[0][1])<0.21);
  assert.deepEqual(unwrapTrail([],0),[]);
});
