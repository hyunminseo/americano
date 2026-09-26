const { mouse } = require('@nut-tree-fork/nut-js');
const { prepareWindow, screenPoint } = require('./windows');
const { KeyboardSender } = require('./keyboard');


function createInputAdapter({ windowAdapter = { prepareWindow, screenPoint }, keyboard = process.platform === 'darwin' ? new (require('./keyboard-mac').MacKeyboard)() : new KeyboardSender(), nativeAdapter = require('./platform') } = {}) {
  return {
    async execute(action, target, control) {
      await control.checkpoint();
      const prepared = await windowAdapter.prepareWindow(target, control);
      await control.checkpoint();
      if (action.type === 'key') { await keyboard.press(action.keys, prepared.window.handle, control); return; }
      if (action.type === 'text') { await keyboard.type(action.text, prepared.window.handle, control); return; }
      if (action.type === 'scroll') {
        if (action.delta_y < 0) await mouse.scrollDown(Math.abs(action.delta_y));
        if (action.delta_y > 0) await mouse.scrollUp(action.delta_y);
        if (action.delta_x < 0) await mouse.scrollLeft(Math.abs(action.delta_x));
        if (action.delta_x > 0) await mouse.scrollRight(action.delta_x);
        return;
      }
      if (action.type === 'mouse_move' || action.type === 'click') {
        const point = action.reference ? require('./resolution').transform(prepared.region, action.reference).point(action.x, action.y) : windowAdapter.screenPoint(prepared.region, action.x, action.y);
        if (!(await nativeAdapter.isPointInWindow(prepared.window.handle, point.x, point.y))) throw new Error('마우스 입력 위치가 다른 창에 가려져 있습니다.');
        await nativeAdapter.moveCursor(point);
        if (action.type === 'click') {
          await control.checkpoint();
          const native = nativeAdapter;
          if (!(await native.isForeground(prepared.window.handle)) || !(await native.isPointInWindow(prepared.window.handle, point.x, point.y))) throw new Error('대상 창이 바뀌어 클릭을 중단했습니다.');
          if (control.onClickPoint) { try { control.onClickPoint({ x: point.x, y: point.y }); } catch { /* 표시는 실패해도 클릭을 막지 않는다. */ } }
          await native.clickMouse(action.button || 'left');
        }
        return;
      }
      throw new Error(`입력 adapter가 지원하지 않는 액션: ${action.type}`);
    },
    async releaseAll() { await keyboard.releaseAll(); },
  };
}

module.exports = { createInputAdapter };
