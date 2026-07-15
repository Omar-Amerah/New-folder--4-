"use strict";
// Compatibility facade: outbound delivery, snapshot delivery, and inbound routing now live in focused modules.
module.exports = {
  ...require("./outbound"),
  ...require("./snapshotDelivery"),
  ...require("./messageRouter")
};
