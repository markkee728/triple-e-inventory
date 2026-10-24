/* ui2-auditlog.js — fills the four summary cards, the "latest" chip and the Action filter
   on the Audit Log page. Display only: it reads auditLogData (already loaded by script.js /
   api-bridge.js) and never changes it. */
(function () {
    "use strict";

    var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    function el(id) { return document.getElementById(id); }
    function setText(id, text) { var n = el(id); if (n) n.textContent = text; }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

    function data() {
        try { if (typeof auditLogData !== "undefined" && Array.isArray(auditLogData)) return auditLogData; } catch (e) {}
        return [];
    }

    function todayKey() {
        var d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function prettyStamp(stamp) {
        var m = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/.exec(String(stamp || ""));
        return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[4] : String(stamp || "");
    }

    /* keep the Action filter in step with the actions that really exist in the log */
    var lastActions = "";
    function syncActionFilter(rows) {
        var sel = el("auditActionFilter");
        if (!sel) return;
        var seen = {};
        rows.forEach(function (r) { if (r.action) seen[r.action] = true; });
        var base = ["Login", "Logout", "Record added", "Record edited", "Account created", "Cash shift", "Return"];
        base.forEach(function (a) { seen[a] = true; });
        var list = Object.keys(seen).sort(function (a, b) {
            var ia = base.indexOf(a), ib = base.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            return a.localeCompare(b);
        });
        var key = list.join("|");
        if (key === lastActions) return;
        lastActions = key;
        var keep = sel.value;
        sel.innerHTML = "";
        var all = document.createElement("option");
        all.value = "all"; all.textContent = "All actions";
        sel.appendChild(all);
        list.forEach(function (a) {
            var o = document.createElement("option");
            o.value = a; o.textContent = a;
            sel.appendChild(o);
        });
        sel.value = list.indexOf(keep) !== -1 ? keep : "all";
    }

    function update() {
        var rows = data();
        var today = todayKey();

        var todayRows = rows.filter(function (r) { return String(r.timestamp || "").indexOf(today) === 0; });
        var people = {};
        rows.forEach(function (r) { if (r.user) people[r.user] = true; });
        var peopleToday = {};
        todayRows.forEach(function (r) { if (r.user) peopleToday[r.user] = true; });
        var changes = rows.filter(function (r) { return /^Record (added|edited|deleted)$/.test(r.action || ""); });
        var logins = todayRows.filter(function (r) { return r.action === "Login"; }).length;

        setText("auKpiTotal", String(rows.length));
        setText("auKpiTotalFoot", rows.length ? "Most recent activity first" : "No activity recorded yet");
        setText("auKpiToday", String(todayRows.length));
        setText("auKpiTodayFoot", todayRows.length ? plural(logins, "sign-in", "sign-ins") + " today" : "Nothing logged today");
        setText("auKpiPeople", String(Object.keys(people).length));
        setText("auKpiPeopleFoot", plural(Object.keys(peopleToday).length, "person", "people") + " active today");
        setText("auKpiChanges", String(changes.length));
        setText("auKpiChangesFoot", "Records added, edited or deleted");

        setText("auditLatest", rows.length ? "Latest: " + prettyStamp(rows[0].timestamp) : "Waiting for activity");
        syncActionFilter(rows);
    }

    function start() {
        update();
        var body = el("auditTableBody");
        if (body) new MutationObserver(update).observe(body, { childList: true });
        setTimeout(update, 800);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
