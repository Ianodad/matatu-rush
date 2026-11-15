/* Matatu Rush: shared board settings. Public by design: a Firebase web API key identifies the project,
   it is not a secret. What a visitor may do is decided by firestore.rules on the server.
   Empty strings (or deleting this file) turn the shared board off; the game then keeps a one-device board. */
(function () {
  'use strict';
  window.MR.ONLINE_CFG = { projectId: 'matatu-rush-board', apiKey: 'AIzaSyA-klPQoiepscCCZH4-lByfkYzdisQ8ug0' };
})();
