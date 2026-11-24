// Clear feedback prompt history retained by older versions of TypeR Studio.
try {
  window.localStorage.removeItem("typer.web.feedback");
} catch {
  // Storage can be unavailable in private browsing.
}
