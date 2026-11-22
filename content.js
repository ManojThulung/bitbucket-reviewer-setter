// Ask main-world.js via CustomEvent; timeoutMs must outlast its internal timeout
function askMainWorld(eventName, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const eventId = `sr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const onResponse = (e) => {
      clearTimeout(timer);
      resolve(e.detail);
    };
    const timer = setTimeout(() => {
      window.removeEventListener(eventId, onResponse);
      resolve(null);
    }, timeoutMs);
    window.addEventListener(eventId, onResponse, { once: true });
    window.dispatchEvent(
      new CustomEvent(eventName, { detail: { ...payload, eventId } })
    );
  });
}

const CHIP_SELECTOR = [
  '[data-tag-text="true"]',
  '[class*="MultiValueLabel"]',
  '[class*="multiValueLabel"]',
  '[class*="multi-value__label"]',
].join(", ");

const CHIP_REMOVE_SELECTOR = [
  'button[aria-label^="Remove" i]',
  '[aria-label^="Remove" i]',
  '[class*="MultiValueRemove"]',
  '[class*="multiValueRemove"]',
  '[class*="multi-value__remove"]',
].join(", ");

let applying = false;

// Inline "remove everyone" button: danger red, with a darker shade for the failed state
// so it stays distinguishable from the idle colour.
const CLEAR_LABEL = "Remove all";
const CLEAR_RED = "#de350b";
const CLEAR_RED_DARK = "#bf2600";

const observers = [];
let dead = false;

function extensionAlive() {
  try {
    return !dead && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Stop all work and strip injected UI; the page needs a reload to get a fresh script
function teardown() {
  if (dead) return;
  dead = true;
  observers.forEach((o) => o.disconnect());
  clearTimeout(inlineTimer);
  document
    .querySelectorAll(
      ".sr-bar, .sr-btn-row, .sr-apply-btn, .sr-clear-btn, .sr-group-select, .sr-add-btn, .sr-toast"
    )
    .forEach((el) => el.remove());
  console.info("[SR] extension was reloaded — refresh this page to re-enable");
}

// Storage wrappers that return null/false once the context is gone
const storage = {
  async get(keys) {
    if (!extensionAlive()) {
      teardown();
      return null;
    }
    try {
      return await chrome.storage.local.get(keys);
    } catch {
      teardown();
      return null;
    }
  },
  async set(obj) {
    if (!extensionAlive()) {
      teardown();
      return false;
    }
    try {
      await chrome.storage.local.set(obj);
      return true;
    } catch {
      teardown();
      return false;
    }
  },
  async remove(keys) {
    if (!extensionAlive()) {
      teardown();
      return false;
    }
    try {
      await chrome.storage.local.remove(keys);
      return true;
    } catch {
      teardown();
      return false;
    }
  },
};

// Load groups state, migrating the old flat savedReviewers list on first run.
// Returns null if the extension context is gone.
async function getGroupsState() {
  const data = await storage.get(["groups", "activeGroupId", "savedReviewers"]);
  if (!data) return null;
  const { groups, activeGroupId, savedReviewers } = data;
  if (Array.isArray(groups) && groups.length) {
    // One-time rename of the old auto-created "Default" group
    const stale = groups.filter((g) => g.name === "Default");
    if (stale.length) {
      stale.forEach((g) => {
        g.name = "My Team";
      });
      await storage.set({ groups });
    }
    const validId = groups.some((g) => g.id === activeGroupId)
      ? activeGroupId
      : groups[0].id;
    return { groups, activeGroupId: validId };
  }
  const def = {
    id: "g" + Date.now().toString(36),
    name: "My Team",
    reviewers: savedReviewers || [],
  };
  const state = { groups: [def], activeGroupId: def.id };
  await storage.set(state);
  await storage.remove("savedReviewers");
  return state;
}

// True on the Create PR page (checked per-event; Bitbucket is a SPA)
function isCreatePrPage() {
  return location.pathname.includes("/pull-requests/new");
}

// An open pull request's own page. Only the bare id and /overview — the /diff,
// /commits etc. tabs are deliberately excluded.
function isExistingPrPage() {
  return /\/pull-requests\/\d+(?:\/overview)?\/?$/.test(location.pathname);
}

function isPrPage() {
  return isCreatePrPage() || isExistingPrPage();
}

// --- Reading who is currently a reviewer -------------------------------------
// Two UI shapes exist: react-select chips and sidebar-style rows. Bitbucket moves
// pages between them, so the shape is read from the DOM, not guessed from the URL.
// Everything downstream goes through currentReviewerNames()/reviewerCount().

const PR_REMOVE_SELECTOR = '[data-testid="remove-reviewer-button"]';
const ADD_REVIEWER_SELECTOR = '[data-testid="add-reviewer-container"]';

// Rows UI if any row is on screen; an open PR always uses it (stray tags elsewhere
// on that page must never be read as chips)
function usesReviewerRows() {
  return isExistingPrPage() || !!document.querySelector(PR_REMOVE_SELECTOR);
}

// Each remove button's parent is its reviewer's row
function prReviewerRows() {
  return [...document.querySelectorAll(PR_REMOVE_SELECTOR)]
    .map((b) => b.parentElement)
    .filter(Boolean);
}

// A row holds the name twice — visibly, and again in the avatar's hidden
// aria-labelledby target — so row.textContent would double it. Resolve the label.
function prRowName(row) {
  const img = row.querySelector('[role="img"][aria-labelledby]');
  const labelled =
    img && document.getElementById(img.getAttribute("aria-labelledby"));
  if (labelled) return normName(labelled.textContent);
  // Fallback: the visible name sits in the row's last profile-card trigger
  const triggers = row.querySelectorAll(
    '[data-testid="user-profile-card-trigger-wrapper"]'
  );
  const last = triggers[triggers.length - 1];
  return normName(last?.textContent || "");
}

function currentReviewerNames() {
  if (usesReviewerRows())
    return prReviewerRows().map(prRowName).filter(Boolean);
  return chipLabels()
    .map((c) => normName(c.textContent))
    .filter(Boolean);
}

function reviewerCount() {
  return usesReviewerRows() ? prReviewerRows().length : chipLabels().length;
}

// True only for the Reviewers listbox, not branch/other dropdowns
function isReviewerListbox(listbox) {
  if (/review/i.test(listbox.id || "")) return true;
  const active = document.activeElement;
  if (!active || !/review/i.test(active.id || "")) return false;
  const controls =
    active.getAttribute("aria-controls") || active.getAttribute("aria-owns");
  return !controls || controls === listbox.id;
}

// "workspace/repo" from the URL, or null
function repoSlug() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Remember which group was last applied in this repo
async function rememberRepoGroup(groupId) {
  const slug = repoSlug();
  if (!slug || !groupId) return;
  const data = await storage.get("repoGroups");
  if (!data) return;
  const repoGroups = data.repoGroups || {};
  if (repoGroups[slug] !== groupId) {
    repoGroups[slug] = groupId;
    await storage.set({ repoGroups });
  }
}

// Auto-select the repo's remembered group, once per visit so manual switches stick
let lastAutoSlug = null;
async function autoSelectRepoGroup() {
  if (!isPrPage()) {
    lastAutoSlug = null;
    return;
  }
  const slug = repoSlug();
  if (!slug || slug === lastAutoSlug) return;
  lastAutoSlug = slug;
  const data = await storage.get("repoGroups");
  if (!data) return;
  const mapped = (data.repoGroups || {})[slug];
  if (!mapped) return;
  const state = await getGroupsState();
  if (!state) return;
  if (
    mapped !== state.activeGroupId &&
    state.groups.some((g) => g.id === mapped)
  ) {
    await storage.set({ activeGroupId: mapped });
  }
}

// Cache group state; invalidated on any storage change
let groupStateCache = null;
async function getGroupsStateCached() {
  if (!groupStateCache) groupStateCache = await getGroupsState();
  return groupStateCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoApply) {
    autoApplyPref = !!changes.autoApply.newValue;
    // Re-arm so switching the toggle on takes effect without a reload
    if (autoApplyPref && autoApplyState === "done") autoApplyState = "idle";
  }
  if (!changes.groups && !changes.activeGroupId && !changes.autoApply) return;
  groupStateCache = null;
  scheduleInlineRefresh();
});

// Debounced refresh of the inline button (observer fires on every DOM change)
let inlineTimer = null;
function scheduleInlineRefresh() {
  if (inlineTimer || !extensionAlive()) return;
  inlineTimer = setTimeout(async () => {
    inlineTimer = null;
    if (!extensionAlive()) {
      teardown();
      return;
    }
    // Each step is independent — a failure in one must not stop auto-apply running
    try {
      await autoSelectRepoGroup();
    } catch (e) {
      console.warn("[SR] repo group select failed:", e);
    }
    try {
      await ensureInlineApplyButton();
    } catch (e) {
      console.warn("[SR] inline button failed:", e);
    }
    try {
      watchForReviewerReset();
    } catch (e) {
      console.warn("[SR] reset watch failed:", e);
    }
    maybeAutoApply();
  }, 300);
}

// --- Finding Bitbucket's reviewer search box ----------------------------------
// Branch selectors are react-select too and mount earlier, so a generic
// input[id^="react-select-"] check is never enough. Bitbucket renames this input
// between releases, so several independent strategies are tried. Whatever is found
// gets marked with SR_INPUT_ATTR: main-world reads the mark, so both worlds always
// type into the same element, and the mark outlives the chips we use to find it.

const SR_INPUT_ATTR = "data-sr-reviewer-input";
const INPUT_CANDIDATES =
  'input[role="combobox"], input[id^="react-select-"], input[type="text"], input[type="search"], input:not([type])';

function usableInput(el) {
  return (
    el?.tagName === "INPUT" &&
    el.type !== "hidden" &&
    el.isConnected &&
    !el.closest(".sr-bar")
  );
}

// Text of the elements an aria-labelledby / aria-describedby attribute points at
function ariaRefText(el, attr) {
  return (el.getAttribute(attr) || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");
}

// First usable input inside root that comes after `marker` in document order — the
// title/description inputs sit above the Reviewers label and must not win
function firstInputAfter(root, marker) {
  return [...root.querySelectorAll(INPUT_CANDIDATES)].find(
    (i) =>
      usableInput(i) &&
      marker.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

function locateReviewerInput() {
  // 1. The known react-select instance id
  const byId = document.querySelector(
    "#react-select-BitbucketPullRequestReviewers-input"
  );
  if (usableInput(byId)) return byId;

  const inputs = [...document.querySelectorAll(INPUT_CANDIDATES)].filter(
    usableInput
  );

  // 2. An input whose id, accessible name, description or placeholder says "review"
  const byText = inputs.find((i) =>
    /review/i.test(
      [
        i.id,
        i.getAttribute("aria-label"),
        i.placeholder,
        ariaRefText(i, "aria-labelledby"),
        ariaRefText(i, "aria-describedby"),
      ].join(" ")
    )
  );
  if (byText) return byText;

  // 3. <label for="…">Reviewers</label> → the element it labels
  const forLabel = [...document.querySelectorAll("label[for]")].find(
    (l) =>
      /^\s*reviewers?\b/i.test(l.textContent) &&
      l.textContent.trim().length < 40
  );
  if (forLabel) {
    const target = document.getElementById(forLabel.htmlFor);
    if (usableInput(target)) return target;
    const inner = target?.querySelector(INPUT_CANDIDATES);
    if (usableInput(inner)) return inner;
  }

  // 4. The input living in the same select control as the reviewer chips. Never
  //    climb past the field holding the Reviewers label: above it sit the branch
  //    selectors and the title input, and typing names into those is far worse
  //    than reporting "not found".
  const chip = document.querySelector(CHIP_SELECTOR);
  if (chip) {
    const label = findReviewersLabel();
    let el = chip.parentElement;
    for (let i = 0; i < 8 && el; i++) {
      const cand = [...el.querySelectorAll(INPUT_CANDIDATES)].find(usableInput);
      if (cand) return cand;
      if (label ? el.contains(label) : i >= 3) break;
      el = el.parentElement;
    }
  }

  // 5. Previously found — survives the chips being cleared
  const marked = document.querySelector(`[${SR_INPUT_ATTR}]`);
  if (usableInput(marked)) return marked;

  // 6. Structural: the nearest input after the "Reviewers" label
  const label = findReviewersLabel();
  if (label) {
    let el = label.parentElement;
    for (let i = 0; i < 6 && el; i++) {
      const cand = firstInputAfter(el, label);
      if (cand) return cand;
      el = el.parentElement;
    }
  }

  // 7. The rows UI keeps its search box inside the "Add reviewer" container
  const inAdd = document.querySelector(`${ADD_REVIEWER_SELECTOR} input`);
  return usableInput(inAdd) ? inAdd : null;
}

function findReviewerInputEl() {
  const input = locateReviewerInput();
  if (input && !input.hasAttribute(SR_INPUT_ATTR)) {
    document
      .querySelectorAll(`[${SR_INPUT_ATTR}]`)
      .forEach((el) => el.removeAttribute(SR_INPUT_ATTR));
    input.setAttribute(SR_INPUT_ATTR, "1");
  }
  return input;
}

// Everything needed to fix the finder when Bitbucket changes the field again:
// the label, the markup around it (classes stripped) and every candidate input.
function describeReviewerField() {
  const label = findReviewersLabel();
  let field = label?.parentElement;
  for (let i = 0; i < 3 && field && field.childElementCount < 2; i++) {
    field = field.parentElement;
  }
  const copy = field?.cloneNode(true);
  copy?.querySelectorAll(".sr-bar").forEach((el) => el.remove());
  const html = (copy?.outerHTML || "(no Reviewers label found)")
    .replace(/\s(class|style)="[^"]*"/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
    .slice(0, 3000);
  const inputs = [...document.querySelectorAll("input")]
    .filter((i) => i.type !== "hidden")
    .slice(0, 25)
    .map((i) =>
      [
        `id=${i.id || "-"}`,
        `type=${i.getAttribute("type") || "-"}`,
        `role=${i.getAttribute("role") || "-"}`,
        `aria-label=${i.getAttribute("aria-label") || "-"}`,
        `labelledby=${ariaRefText(i, "aria-labelledby").trim() || "-"}`,
        `placeholder=${i.placeholder || "-"}`,
      ].join(" ")
    );
  return [
    `label: ${label ? label.outerHTML.slice(0, 200) : "none"}`,
    `inputs:\n  ${inputs.join("\n  ") || "none"}`,
    `field html:\n${html}`,
  ].join("\n");
}

// Auto-apply the active group once per Create PR page visit (opt-in, off by default).
// State is claimed synchronously so overlapping observer ticks can't double-apply.
const AUTO_APPLY_MAX_ATTEMPTS = 3;
const MAX_REAPPLIES = 4;
let autoApplyState = "idle"; // idle | running | done
let autoApplyAttempts = 0;
let autoApplyPref = null; // cached setting; null = not read yet
let appliedNames = null; // what we last successfully applied
let reapplies = 0;
let lastDestSig = null;
let gateLoggedAt = 0;

// A stable fingerprint of the current reviewer chips
function chipSignature() {
  return currentReviewerNames().sort();
}

// Target branch, read from the URL Bitbucket keeps in sync with the form
function destSignature() {
  const p = new URLSearchParams(location.search);
  return p.get("dest") || p.get("destination") || p.get("targetBranch") || "";
}

// Wait until the chips stop changing. Bitbucket loads its default reviewers for the
// target branch asynchronously, and applying before that lands means its defaults
// arrive on top of ours — which looks exactly like auto-apply never ran.
// minMs matters: an empty field goes "quiet" instantly, but empty usually means
// Bitbucket simply hasn't fetched its defaults yet — applying then puts our reviewers
// underneath the defaults that arrive a moment later.
async function waitForChipsToSettle(quietMs = 900, maxMs = 9000, minMs = 2500) {
  const start = Date.now();
  let last = null;
  let stableSince = start;
  while (Date.now() - start < maxMs) {
    const sig = chipSignature().join("|");
    if (sig !== last) {
      last = sig;
      stableSince = Date.now();
    } else if (
      Date.now() - stableSince >= quietMs &&
      Date.now() - start >= minMs
    ) {
      return;
    }
    await delay(150);
  }
  console.info("[SR] reviewer list never settled; applying anyway");
}

// Re-arm auto-apply when Bitbucket resets the reviewers: switching the target branch
// repopulates its own defaults, and late-loading defaults can land after we applied.
function watchForReviewerReset() {
  if (!isCreatePrPage()) {
    lastDestSig = null;
    reapplies = 0;
    appliedNames = null;
    return;
  }
  if (!autoApplyPref || applying) return;

  const dest = destSignature();
  if (lastDestSig === null) {
    lastDestSig = dest;
  } else if (dest !== lastDestSig) {
    lastDestSig = dest;
    rearmAutoApply("target branch changed");
    return;
  }

  // Someone we did not add showed up — that's Bitbucket repopulating its defaults
  if (autoApplyState === "done" && appliedNames) {
    const foreign = chipSignature().some((n) => !appliedNames.includes(n));
    if (foreign) rearmAutoApply("reviewers were reset");
  }
}

function rearmAutoApply(why) {
  if (reapplies >= MAX_REAPPLIES) return;
  reapplies++;
  console.info(
    `[SR] ${why} — re-applying reviewers (${reapplies}/${MAX_REAPPLIES})`
  );
  autoApplyState = "idle";
  autoApplyAttempts = 0;
  appliedNames = null;
  scheduleInlineRefresh();
}

async function maybeAutoApply() {
  if (!isCreatePrPage()) {
    autoApplyState = "idle";
    autoApplyAttempts = 0;
    return;
  }
  if (autoApplyState !== "idle") return;
  // null = preference not read yet (primed at startup); false = switched off
  if (autoApplyPref !== true) return;

  // The field counts as ready once it's on screen and we can find either the input
  // or existing reviewers — main-world has its own input finder, so a miss here must
  // not block us. All checks stay synchronous: claiming the lock after an await races.
  const field = findControlsAnchor();
  const input = findReviewerInputEl();
  const count = reviewerCount();
  if (!field || (!input && !count)) {
    // Never fail silently — a blocked gate used to be invisible
    if (Date.now() - gateLoggedAt > 10000) {
      gateLoggedAt = Date.now();
      console.info(
        `[SR] auto-apply waiting for the reviewers field — field=${!!field} input=${!!input} reviewers=${count}`
      );
    }
    return;
  }
  autoApplyState = "running";

  autoApplyAttempts++;
  console.info(
    `[SR] auto-apply: reviewer field ready, attempt ${autoApplyAttempts}`
  );

  // Let Bitbucket finish loading its own default reviewers before touching them
  (async () => {
    await waitForChipsToSettle();
    // A manual Clear during the settle window takes precedence over auto-apply
    if (autoApplyState !== "running") return;

    const state = await getGroupsState();
    if (!state) {
      autoApplyState = "done";
      return;
    }
    const group =
      state.groups.find((g) => g.id === state.activeGroupId) || state.groups[0];
    if (!group.reviewers.length) {
      console.info(
        `[SR] auto-apply: group "${group.name}" is empty, nothing to do`
      );
      autoApplyState = "done";
      return;
    }

    const snapshot = currentReviewerNames();
    const target = group.reviewers.map((r) => normName(r.name)).sort();
    const current = chipSignature();
    if (
      target.length === current.length &&
      target.every((n, i) => n === current[i])
    ) {
      console.info("[SR] auto-apply: reviewers already match, nothing to do");
      appliedNames = target;
      autoApplyState = "done";
      return;
    }

    try {
      await applyReviewers(group.reviewers);
      await rememberRepoGroup(group.id);
      // Record what we INTENDED, not the field afterwards: Bitbucket can add its
      // defaults while we're applying, and capturing those would make the reset
      // watcher treat them as ours and never notice the clobber.
      appliedNames = target;
      autoApplyState = "done";
      showToast(`Reviewers set to "${group.name}"`, snapshot);
    } catch (err) {
      // The field may still have been settling; allow a bounded retry
      if (autoApplyAttempts < AUTO_APPLY_MAX_ATTEMPTS) {
        console.warn(
          `[SR] auto-apply attempt ${autoApplyAttempts} failed, will retry:`,
          err.message
        );
        autoApplyState = "idle";
        scheduleInlineRefresh();
      } else {
        console.warn("[SR] auto-apply failed:", err);
        autoApplyState = "done";
        showToast(`Auto-apply failed: ${err.message}`, null);
      }
    }
  })();
}

// Bitbucket-styled toast; Undo restores the pre-apply reviewer snapshot
function showToast(message, undoSnapshot) {
  document.querySelector(".sr-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "sr-toast";
  toast.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        background: #172b4d;
        color: white;
        border-radius: 4px;
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 16px rgba(9, 30, 66, 0.25);
    `;
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  const dismiss = setTimeout(() => toast.remove(), 10000);

  if (undoSnapshot) {
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    undo.style.cssText =
      "background:none; border:none; color:#4c9aff; font-weight:600; font-size:13px; cursor:pointer; padding:0;";
    undo.addEventListener("click", async () => {
      clearTimeout(dismiss);
      undo.remove();
      text.textContent = "Restoring previous reviewers…";
      try {
        await applyReviewers(undoSnapshot.map((name) => ({ name })));
        text.textContent = "Previous reviewers restored.";
      } catch (err) {
        text.textContent = "Restore failed: " + err.message;
      }
      setTimeout(() => toast.remove(), 3000);
    });
    toast.appendChild(undo);
  }

  const close = document.createElement("button");
  close.textContent = "×";
  close.style.cssText =
    "background:none; border:none; color:#97a0af; font-size:16px; cursor:pointer; padding:0; line-height:1;";
  close.addEventListener("click", () => {
    clearTimeout(dismiss);
    toast.remove();
  });
  toast.appendChild(close);

  document.body.appendChild(toast);
}

// Text from an element's own text nodes, ignoring child elements
function ownText(el) {
  return [...el.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("")
    .trim();
}

// The "Reviewers" field label. Exact leaf text first; then a label whose own text
// is "Reviewers" but also holds a required marker or info icon.
function findReviewersLabel() {
  const els = [
    ...document.querySelectorAll("label, legend, h2, h3, h4, span, div"),
  ];
  const outside = (el) => !el.closest('[role="listbox"], .sr-bar');
  // Cheap checks first: textContent on a big container is expensive, and this runs
  // on every refresh tick
  return (
    els.find(
      (el) =>
        el.childElementCount === 0 &&
        /^reviewers?$/i.test(el.textContent.trim()) &&
        outside(el)
    ) ||
    els.find(
      (el) =>
        el.childElementCount > 0 &&
        /^reviewers?\s*\*?$/i.test(ownText(el)) &&
        el.textContent.trim().length < 40 &&
        outside(el)
    )
  );
}

// Sidebar-style section header ("<n> reviewers" + collapse toggle)
function findReviewersSectionHeader() {
  const h2 = [...document.querySelectorAll("h2, h3")].find(
    (h) =>
      /\breviewers?\b/i.test(h.textContent) && h.textContent.trim().length < 40
  );
  if (!h2) return null;
  // Climb to the row that also holds the collapse toggle — that whole row is what
  // we sit above.
  let header = h2.parentElement;
  for (let i = 0; i < 4 && header; i++) {
    if (header.querySelector('[aria-label="collapse"], [aria-label="expand"]')) {
      return header;
    }
    header = header.parentElement;
  }
  return h2;
}

// Where the control bar goes. Tried in order on both pages, since Bitbucket swaps
// which reviewer UI each page uses:
//   form label   → inline, beside the label (wide form)
//   rows section → stacked block above the header (narrow column)
function findControlsAnchor() {
  // The add-reviewer container marks the rows UI even before any row exists
  const rowsUi =
    usesReviewerRows() || !!document.querySelector(ADD_REVIEWER_SELECTOR);
  const label = !isExistingPrPage() && !rowsUi && findReviewersLabel();
  if (label) return { el: label, position: "afterend", layout: "inline" };

  const header = findReviewersSectionHeader();
  if (header) return { el: header, position: "beforebegin", layout: "stack" };

  // Above the panel holding the rows and the "Add reviewer" control
  const add = document.querySelector(ADD_REVIEWER_SELECTOR);
  const panel = add?.closest(".panel-content") || add?.parentElement;
  if (panel) return { el: panel, position: "beforebegin", layout: "stack" };

  // Rows UI with no recognisable header: the label is still better than nothing
  const lateLabel = !isExistingPrPage() && findReviewersLabel();
  return lateLabel
    ? { el: lateLabel, position: "afterend", layout: "inline" }
    : null;
}

// On a PR page with no recognisable reviewers field, say what was looked for —
// throttled, and only after the page has had time to render. This is what turns
// "the buttons vanished" into something diagnosable from the console.
let missingSince = 0; // when the field went missing on this page; 0 = present
let missingPath = "";
let missingLoggedAt = 0;
function logMissingField() {
  const now = Date.now();
  if (!missingSince || missingPath !== location.pathname) {
    missingSince = now;
    missingPath = location.pathname;
  }
  if (now - missingSince < 4000 || now - missingLoggedAt < 15000) return;
  missingLoggedAt = now;
  console.info(
    "[SR] reviewers field not found —",
    `label=${!!findReviewersLabel()}`,
    `header=${!!findReviewersSectionHeader()}`,
    `addContainer=${!!document.querySelector(ADD_REVIEWER_SELECTOR)}`,
    `input=${findReviewerInputEl()?.id || !!findReviewerInputEl()}`,
    `rows=${prReviewerRows().length}`,
    `chips=${document.querySelectorAll(CHIP_SELECTOR).length}`
  );
}

// Write only real changes. Assigning textContent always swaps in a new text node —
// a DOM mutation even when the text is identical — and that re-fired our own page
// observer, which refreshed again 300ms later: an endless loop on every page.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setStyle(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}
function setDisabled(el, value) {
  if (el.disabled !== value) el.disabled = value;
}

// Keep the group selector + Apply + Remove all bar attached to the reviewers field
async function ensureInlineApplyButton() {
  let bar = document.querySelector(".sr-bar");
  let row = document.querySelector(".sr-btn-row");
  let btn = document.querySelector(".sr-apply-btn");
  let sel = document.querySelector(".sr-group-select");
  let clr = document.querySelector(".sr-clear-btn");
  if (bar && !bar.isConnected) bar = null;
  if (row && !row.isConnected) row = null;
  if (btn && !btn.isConnected) btn = null;
  if (sel && !sel.isConnected) sel = null;
  if (clr && !clr.isConnected) clr = null;
  const removeAll = () => {
    [bar, row, btn, sel, clr].forEach((el) => el?.remove());
  };
  if (!isPrPage()) {
    removeAll();
    return;
  }

  const anchor = findControlsAnchor();
  if (!anchor) {
    removeAll();
    logMissingField();
    return;
  }
  missingSince = 0;

  let created = false; // a fresh element needs the layout styles below
  if (!bar) {
    bar = document.createElement("span");
    bar.className = "sr-bar";
    created = true;
  }
  if (!row) {
    row = document.createElement("span");
    row.className = "sr-btn-row";
    created = true;
  }
  if (!sel) {
    created = true;
    sel = document.createElement("select");
    sel.className = "sr-group-select";
    sel.title = "Active reviewer group";
    sel.style.cssText = `
            padding: 3px 4px;
            max-width: 150px;
            font-size: 12px;
            color: #172b4d;
            background: #fafbfc;
            border: 2px solid #dfe1e6;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
            outline: none;
        `;
    sel.addEventListener("mousedown", (e) => e.stopPropagation());
    sel.addEventListener("change", () =>
      storage.set({ activeGroupId: sel.value })
    );
  }
  if (!btn) {
    created = true;
    btn = document.createElement("button");
    btn.className = "sr-apply-btn";
    btn.type = "button";
    btn.style.cssText = `
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            background: #0052cc;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
        `;
    btn.addEventListener("click", onInlineApply);
  }
  if (!clr) {
    created = true;
    clr = document.createElement("button");
    clr.className = "sr-clear-btn";
    clr.type = "button";
    clr.title = "Remove every reviewer from this pull request";
    // Destructive action, so it carries the danger colour rather than sitting
    // quietly next to Apply
    clr.style.cssText = `
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            background: ${CLEAR_RED};
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
        `;
    clr.addEventListener("click", onInlineClear);
  }
  // Structure: bar > [ select, row > [ Apply, Remove all ] ]
  if (sel.parentElement !== bar) bar.appendChild(sel);
  if (row.parentElement !== bar) bar.appendChild(row);
  if (btn.parentElement !== row) row.appendChild(btn);
  if (clr.parentElement !== row) row.appendChild(clr);

  // Layout follows the anchor, so an SPA move between the create form and a PR page
  // picks up the right shape. Re-applied only when it changes (see setText).
  if (!created && bar.dataset.layout === anchor.layout) {
    // already laid out for this anchor
  } else if (anchor.layout === "inline") {
    // Wide form: everything on one line beside the Reviewers label
    bar.style.cssText =
      "display:inline-flex; align-items:center; gap:6px; vertical-align:middle; margin:0 0 0 8px;";
    row.style.cssText = "display:inline-flex; align-items:center; gap:6px;";
    sel.style.width = "";
    sel.style.maxWidth = "150px";
    btn.style.flex = "";
    clr.style.flex = "";
  } else {
    // Narrow sidebar: full-width select, then the two buttons sharing a row evenly
    bar.style.cssText =
      "display:flex; flex-direction:column; gap:6px; width:100%; margin:0 0 8px 0;";
    row.style.cssText =
      "display:flex; align-items:stretch; gap:6px; width:100%;";
    sel.style.width = "100%";
    sel.style.maxWidth = "none";
    btn.style.flex = "1";
    clr.style.flex = "1";
  }
  bar.dataset.layout = anchor.layout;

  // Re-attach if React re-rendered the anchor out from under us
  if (!bar.isConnected || bar.parentElement !== anchor.el.parentElement) {
    anchor.el.insertAdjacentElement(anchor.position, bar);
  }

  // Only meaningful when there is something to remove
  if (!clr.dataset.busy && !clr.dataset.armed) {
    const hasChips = reviewerCount() > 0;
    setText(clr, CLEAR_LABEL);
    setDisabled(clr, !hasChips);
    setStyle(clr, "opacity", hasChips ? "1" : "0.5");
    setStyle(clr, "cursor", hasChips ? "pointer" : "default");
  }

  const state = await getGroupsStateCached();
  if (!state) return;
  const { groups, activeGroupId } = state;
  const group = groups.find((g) => g.id === activeGroupId) || groups[0];

  // Rebuild options only when data changed and the select isn't being used
  if (document.activeElement !== sel) {
    const sig =
      groups.map((g) => `${g.id}:${g.name}:${g.reviewers.length}`).join("|") +
      "@" +
      group.id;
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = "";
      groups.forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g.id;
        opt.textContent = `${g.name} (${g.reviewers.length})`;
        sel.appendChild(opt);
      });
      sel.value = group.id;
    }
  }

  if (btn.dataset.busy) return; // don't clobber Applying/result feedback
  setText(btn, "Apply");
  const empty = group.reviewers.length === 0;
  setDisabled(btn, empty);
  setStyle(btn, "opacity", empty ? "0.5" : "1");
  setStyle(btn, "cursor", empty ? "default" : "pointer");
}

// Remove every reviewer from the field, without applying a group
async function onInlineClear() {
  const clr = document.querySelector(".sr-clear-btn");
  if (!clr || clr.dataset.busy || applying) return;
  const count = reviewerCount();
  if (!count) return;

  // On an open PR this takes effect immediately and notifies people, so require a
  // deliberate second click. The create form isn't submitted yet, so one click is fine.
  if (isExistingPrPage() && !clr.dataset.armed) {
    clr.dataset.armed = "1";
    clr.textContent = `Remove ${count}?`;
    clr.style.background = CLEAR_RED_DARK;
    setTimeout(() => {
      if (!clr.dataset.armed) return;
      delete clr.dataset.armed;
      clr.style.background = CLEAR_RED;
      ensureInlineApplyButton();
    }, 3000);
    return;
  }
  delete clr.dataset.armed;

  clr.dataset.busy = "1";
  clr.disabled = true;
  clr.textContent = "Removing…";

  // Same suspension the apply path uses: stops "+ Add" injection and the reset
  // watcher from reacting to the chips we are about to remove.
  applying = true;
  document.querySelectorAll(".sr-add-btn").forEach((b) => b.remove());
  try {
    await removeAllReviewers();
    // A manual clear has to stick. Marking auto-apply done (and forgetting what we
    // applied) stops it refilling the field a moment later; a target-branch change
    // still re-arms it, which is the one case where refilling is right.
    autoApplyState = "done";
    appliedNames = null;
    const left = reviewerCount();
    clr.textContent = left ? "✗ Failed" : "✓ Removed";
    clr.style.background = left ? CLEAR_RED_DARK : "#36b37e";
  } catch (err) {
    console.warn("[SR] remove all failed:", err);
    clr.textContent = "✗ Failed";
    clr.style.background = CLEAR_RED_DARK;
  } finally {
    applying = false;
  }

  setTimeout(() => {
    delete clr.dataset.busy;
    clr.disabled = false;
    clr.style.background = CLEAR_RED;
    ensureInlineApplyButton();
  }, 2000);
}

// Apply the active group straight from the page
async function onInlineApply() {
  const btn = document.querySelector(".sr-apply-btn");
  if (!btn || btn.dataset.busy) return;
  const state = await getGroupsStateCached();
  if (!state) return;
  const group =
    state.groups.find((g) => g.id === state.activeGroupId) || state.groups[0];
  if (!group.reviewers.length) return;

  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "Applying…";
  try {
    await applyReviewers(group.reviewers);
    await rememberRepoGroup(group.id);
    btn.textContent = "✓ Applied";
    btn.style.background = "#36b37e";
  } catch (err) {
    console.warn("[SR] inline apply failed:", err);
    btn.textContent = "✗ Failed";
    btn.title = err.message;
    btn.style.background = "#de350b";
  }
  setTimeout(() => {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.title = "";
    btn.style.background = "#0052cc";
    ensureInlineApplyButton();
  }, 2500);
}

// Inject "+ Add" buttons when the reviewer dropdown opens
// React recreates the listbox on every open, so observers must be released when
// their listbox detaches — otherwise they pile up and each one re-scans on every mutation.
const listboxObservers = new Map();

function pruneListboxObservers() {
  for (const [listbox, obs] of listboxObservers) {
    if (!listbox.isConnected) {
      obs.disconnect();
      listboxObservers.delete(listbox);
    }
  }
}

// Our own controls changing (button labels, toast text) is never a reason to refresh
const OWN_UI = ".sr-bar, .sr-toast";
function isOwnMutation(record) {
  const t = record.target;
  const el = t.nodeType === Node.ELEMENT_NODE ? t : t.parentElement;
  return !!el?.closest?.(OWN_UI);
}

const dropdownObserver = new MutationObserver((records) => {
  if (!extensionAlive()) {
    teardown();
    return;
  }
  if (records.every(isOwnMutation)) return;
  scheduleInlineRefresh();
  // Stay out of the way while we're driving the field ourselves
  if (!isPrPage() || applying) return;
  pruneListboxObservers();
  document.querySelectorAll('[role="listbox"]').forEach((listbox) => {
    if (listboxObservers.has(listbox) || !isReviewerListbox(listbox)) return;
    injectAddButtons(listbox);

    const innerObserver = new MutationObserver(() => injectAddButtons(listbox));
    innerObserver.observe(listbox, { childList: true, subtree: true });
    listboxObservers.set(listbox, innerObserver);
    observers.push(innerObserver);
  });
});
dropdownObserver.observe(document.body, { childList: true, subtree: true });
observers.push(dropdownObserver);

// Prime the auto-apply preference up front so maybeAutoApply can check it
// synchronously, instead of claiming its lock and then awaiting storage.
storage.get("autoApply").then((data) => {
  if (data) autoApplyPref = !!data.autoApply;
  console.info(`[SR] loaded — auto-apply is ${autoApplyPref ? "ON" : "off"}`);
  scheduleInlineRefresh();
});

scheduleInlineRefresh();

function extractFromDOM(optionEl) {
  const img = optionEl.querySelector("img");
  const avatarUrl = img?.src || "";

  const clone = optionEl.cloneNode(true);
  clone.querySelector(".sr-add-btn")?.remove();
  const name = clone.textContent.trim();

  // "initials" is a shared avatar-service path, not an account id
  const match = avatarUrl.match(/atl-paas\.net\/([^/]+)\//);
  const seg = match ? decodeURIComponent(match[1]) : null;
  const id = seg && seg !== "initials" ? seg : name;

  return { id, name, avatarUrl };
}

function injectAddButtons(listbox) {
  if (applying || !listbox.isConnected) return;
  listbox.querySelectorAll('[role="option"]').forEach((option, idx) => {
    // Refresh idx every pass; the option list changes as the user types
    option.setAttribute("data-sr-idx", idx);
    if (option.querySelector(".sr-add-btn")) return;

    const btn = document.createElement("button");
    btn.className = "sr-add-btn";
    btn.textContent = "+ Add";
    btn.style.cssText = `
            order: 9999;
            margin-left: auto;
            padding: 2px 10px;
            font-size: 11px;
            font-weight: 600;
            background: #0052cc;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            flex-shrink: 0;
            z-index: 9999;
        `;

    btn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      // Read idx at click time; the closure value goes stale when the list re-renders
      const liveIdx = Number(option.getAttribute("data-sr-idx"));
      const rawData = await askMainWorld("sr-get-option-data", {
        idx: liveIdx,
      });
      const domData = extractFromDOM(option);

      // Trust API data only when it describes the user we actually clicked
      const raw =
        rawData?.name &&
        domData.name &&
        rawData.name.toLowerCase() === domData.name.toLowerCase()
          ? rawData
          : null;
      const reviewer = {
        id: raw?.id || domData.id,
        name: domData.name || raw?.name,
        avatarUrl: raw?.avatarUrl || domData.avatarUrl,
      };

      if (!reviewer.name) {
        console.warn("[SR] Could not read reviewer name from option");
        return;
      }

      // Save into the active group; dedupe by id or name
      const state = await getGroupsState();
      if (!state) {
        btn.textContent = "Reload page";
        btn.style.background = "#de350b";
        return;
      }
      const group =
        state.groups.find((g) => g.id === state.activeGroupId) ||
        state.groups[0];
      const exists = group.reviewers.some(
        (r) =>
          r.id === reviewer.id ||
          r.name.toLowerCase() === reviewer.name.toLowerCase()
      );
      if (!exists) {
        group.reviewers.push(reviewer);
        await storage.set({ groups: state.groups });
      }

      btn.textContent = exists
        ? `Already in ${group.name}`
        : `✓ → ${group.name}`;
      btn.style.background = exists ? "#6b778c" : "#36b37e";
      setTimeout(() => {
        btn.textContent = "+ Add";
        btn.style.background = "#0052cc";
      }, 2000);
    });

    option.style.display = "flex";
    option.style.alignItems = "center";
    option.appendChild(btn);
  });
}

// Handle popup messages; Apply only allowed on a pull request page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "status") {
    sendResponse({
      ok: true,
      isCreatePrPage: isPrPage(),
      currentReviewers: currentReviewerNames(),
    });
    return;
  }
  if (msg.action !== "apply") return;
  if (!isPrPage()) {
    sendResponse({
      ok: false,
      error: "Open a pull request (new or existing) first.",
    });
    return;
  }
  applyReviewers(msg.reviewers)
    .then(async () => {
      await rememberRepoGroup(msg.groupId);
      sendResponse({ ok: true });
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function waitForReviewersToAppear(reviewers, timeoutMs = 8000) {
  if (!reviewers.length) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (reviewers.every((r) => isInField(r.name))) return;
    await delay(250);
  }
  console.info(
    "[SR] some reviewers had not appeared before the check timed out"
  );
}

async function applyReviewers(reviewers) {
  // Suspend our own DOM injection for the duration; see the `applying` comment above
  applying = true;
  document.querySelectorAll(".sr-add-btn").forEach((b) => b.remove());
  const t0 = Date.now();
  try {
    // Find the search box BEFORE touching anything: removing everyone and then
    // discovering we can't add anybody leaves the PR with no reviewers at all.
    // Looking now, while the chips still exist, also lets the chip-based strategy
    // find (and mark) the input.
    if (!findReviewerInputEl()) {
      console.warn(
        "[SR] reviewer search box not found — nothing was changed. Please share this:\n" +
          describeReviewerField()
      );
      throw new Error(
        "Couldn't find Bitbucket's reviewer search box — nothing was changed."
      );
    }

    // Clear the field FIRST. react-select hides already-selected people from its
    // search results, so anything left behind can never be re-selected — we'd wait
    // out the full timeout for an option that cannot render.
    await removeAllReviewers();

    for (const reviewer of reviewers) {
      findReviewerInputEl(); // keep the mark on the right element for main-world
      const result = await addReviewer(reviewer);
      if (result?.reason === "reviewer input not found") {
        // Every remaining add would fail the same way — stop now, not after
        // waiting out each one
        console.warn(
          "[SR] reviewer search box disappeared after clearing. Please share this:\n" +
            describeReviewerField()
        );
        throw new Error(
          "Bitbucket's reviewer search box disappeared — reload the page and try again."
        );
      }
    }

    // On an open PR each add is a server round-trip and its sidebar row only appears
    // once Bitbucket responds, so the field lags behind the last add. Let it catch up
    // before judging, or correctly-applied reviewers get reported as failures.
    await waitForReviewersToAppear(reviewers);

    // Judge success by what is actually in the field, not by each add's return
    // value: an add can time out after it already landed, and a reviewer who was
    // present all along may be skipped without us having detected it.
    const failed = [
      ...new Set(
        reviewers.filter((r) => !isInField(r.name)).map((r) => r.name)
      ),
    ];
    console.info(
      `[SR] apply: ${reviewers.length - failed.length}/${
        reviewers.length
      } in field after ${Date.now() - t0}ms`
    );

    if (failed.length) {
      throw new Error(
        `Could not add: ${failed.join(
          ", "
        )}. Try again — the rest were applied.`
      );
    }
  } finally {
    applying = false;
  }
}

const normName = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Whole-name match: a chip may carry extra text, but a loose substring test would
// treat "John" as present when only "Johnathan" is.
function textHasName(text, name) {
  const t = normName(text);
  const n = normName(name);
  if (!n) return false;
  if (t === n) return true;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${esc}(\\s|,|$)`).test(t);
}

// Is this reviewer currently a chip in the Reviewers field?
function isInField(name) {
  return currentReviewerNames().some((n) => textHasName(n, name));
}

// Nearest ancestor of the reviewer input that also holds the chips, so tags belonging
// to other fields on the page can never be mistaken for reviewers.
function reviewersFieldRoot() {
  const input = findReviewerInputEl();
  if (!input) return document;
  let el = input.parentElement;
  for (let i = 0; i < 8 && el; i++) {
    if (el.querySelector(CHIP_SELECTOR)) return el;
    el = el.parentElement;
  }
  return document;
}

// Every chip label currently in the Reviewers field
function chipLabels() {
  return [...reviewersFieldRoot().querySelectorAll(CHIP_SELECTOR)];
}

// The clickable "×" for a chip. Class names change between Bitbucket releases, so
// fall back to structure: any button/role=button, or an element labelled "remove".
function findRemoveControl(label) {
  const container =
    label.closest('[class*="MultiValue"], [class*="multi-value"]') ||
    label.parentElement;
  if (!container) return null;
  const scopes = [container, container.parentElement].filter(Boolean);
  for (const scope of scopes) {
    const direct = scope.querySelector(CHIP_REMOVE_SELECTOR);
    if (direct) return direct;
    const labelled = [...scope.querySelectorAll("[aria-label]")].find((el) =>
      /remove|clear|delete/i.test(el.getAttribute("aria-label"))
    );
    if (labelled) return labelled;
    const button = scope.querySelector('button, [role="button"]');
    if (button && !button.contains(label)) return button;
  }
  return null;
}

// Wait for the chip count to actually drop. A fixed delay is not safe here: React can
// take well over 100ms to re-render a long reviewer list on a busy page, and treating
// that as "the click did nothing" aborts the whole clear.
// The next reviewer's remove control, whichever page shape we're on. `skip` lets the
// caller move past one that isn't responding.
function nextRemoveControl(skip = 0) {
  if (usesReviewerRows()) {
    const btns = document.querySelectorAll(PR_REMOVE_SELECTOR);
    return btns.length ? btns[Math.min(skip, btns.length - 1)] : null;
  }
  const labels = chipLabels();
  if (!labels.length) return null;
  return findRemoveControl(labels[Math.min(skip, labels.length - 1)]);
}

async function waitForChipDrop(from, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(80);
    if (reviewerCount() < from) return true;
  }
  return false;
}

// react-select removes the last selected value on Backspace when the input is empty.
// Class-name independent, so it works even when the markup changes underneath us.
async function clearWithBackspace() {
  const input = findReviewerInputEl();
  if (!input) return;
  let stalls = 0;
  for (let i = 0; i < 60 && chipLabels().length; i++) {
    const before = chipLabels().length;
    input.focus();
    for (const type of ["keydown", "keyup"]) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          which: 8,
        })
      );
    }
    if (await waitForChipDrop(before, 1200)) stalls = 0;
    else if (++stalls >= 3) return; // genuinely not working
  }
}

// Clear the whole Reviewers field before adding: react-select hides already-selected
// people from search, so anything left behind can never be re-selected as an option.
async function removeAllReviewers() {
  const started = reviewerCount();
  if (!started) {
    // Log rather than return silently: "no chips" and "chip selectors don't match
    // this markup" look identical from here, and the latter is a real bug.
    console.info("[SR] no existing reviewer chips detected — nothing to clear");
    return;
  }

  let stalls = 0;
  // Generous guard: one pass per chip, plus room for retries
  for (let guard = 0; guard < started * 3 + 10; guard++) {
    const count = reviewerCount();
    if (!count) break;

    // On a stall, try a different reviewer — one uncooperative button shouldn't
    // block the rest of the list.
    const btn = nextRemoveControl(stalls);
    if (!btn) break; // fall through to the keyboard path

    btn.click();
    if (await waitForChipDrop(count)) {
      stalls = 0;
    } else if (++stalls >= 3) {
      break; // clicking isn't landing; try Backspace
    }
  }

  // Backspace only clears react-select chips; the rows UI ignores it
  if (reviewerCount() && !usesReviewerRows()) await clearWithBackspace();

  const left = reviewerCount();
  if (left) {
    console.warn(
      `[SR] could not clear ${left} of ${started} reviewers — remove control not responding`
    );
  } else {
    console.info(`[SR] cleared ${started} existing reviewer(s)`);
  }
}

async function addReviewer(reviewer) {
  // Outlast main-world's 10s dropdown timeout
  const result = await askMainWorld("sr-add-reviewer", { reviewer }, 13000);
  if (!result?.ok) {
    console.warn("[SR] addReviewer failed:", reviewer.name, result);
    if (result?.reason === "reviewer input not found") return result;
  }
  await delay(400); // let React render the new chip
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
