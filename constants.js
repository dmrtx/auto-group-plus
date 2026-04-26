(function initAutoGroupConstants(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.AutoGroupConstants = api;
})(globalThis, function createAutoGroupConstants() {
  const MESSAGE_ACTIONS = Object.freeze({
    CANCEL_MERGE: 'CANCEL_MERGE',
    CONFIRM_MERGE: 'CONFIRM_MERGE',
    GET_OVERVIEW: 'GET_OVERVIEW',
    REBUILD_GROUPS: 'REBUILD_GROUPS',
    REGROUP_TAB: 'REGROUP_TAB',
    SHOW_COUNTDOWN: 'SHOW_COUNTDOWN'
  });

  return {
    MESSAGE_ACTIONS
  };
});
