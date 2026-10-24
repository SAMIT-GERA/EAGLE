import { describe, expect, it } from 'vitest';
import { activateEyeEntry, eyeTarget, shouldEnterEyePipeline } from './landingInteraction';

describe('EAGLE eye entry interaction', () => {
  it('bounds pointer movement inside the eye opening', () => {
    expect(eyeTarget(0,0,{left:0,top:0,width:100,height:100})).toEqual({x:-11,y:-6});
    expect(eyeTarget(100,100,{left:0,top:0,width:100,height:100})).toEqual({x:11,y:6});
    expect(eyeTarget(50,50,{left:0,top:0,width:100,height:100})).toEqual({x:0,y:0});
  });

  it('recognizes both native button activation keys', () => {
    expect(shouldEnterEyePipeline('Enter')).toBe(true);
    expect(shouldEnterEyePipeline(' ')).toBe(true);
    expect(shouldEnterEyePipeline('Escape')).toBe(false);
  });

  it('uses the same entry handler for click and keyboard activation', () => {
    let entries = 0;
    expect(activateEyeEntry(() => { entries++; })).toBe(true);
    expect(activateEyeEntry(() => { entries++; },'Enter')).toBe(true);
    expect(activateEyeEntry(() => { entries++; },' ')).toBe(true);
    expect(activateEyeEntry(() => { entries++; },'Escape')).toBe(false);
    expect(entries).toBe(3);
  });
});
