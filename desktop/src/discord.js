
"use strict";

/**
 * Nemesis Edition - Discord integration disabled.
 *
 * Rich Presence is intentionally unavailable.
 * No Discord IPC connections are established.
 * No application activity is shared with Discord.
 *
 * The original module interface is preserved.
 */

const set = () => {};

const stop = () => {};

module.exports = {
  set,
  stop,
  available: false
};
