// Clear usage data retained by older versions of TypeR Studio.
try {
  window.localStorage.removeItem("typer.web.stats");
  window.localStorage.removeItem("typer.web.stats.days");
} catch {
  // Storage can be unavailable in private browsing.
}
