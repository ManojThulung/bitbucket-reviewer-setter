// Runs in the MAIN world — shares globals with Bitbucket's own JS, so everything
// is wrapped in an IIFE to avoid clobbering (or being clobbered by) page globals.
(() => {
  const apiDataCache = new Map();

  function cacheUsers(users) {
    if (!Array.isArray(users)) return;
    users.forEach((user) => {
      if (user && user.id && user.name) {
        apiDataCache.set(user.id, user);
        apiDataCache.set("name:" + user.name.toLowerCase(), user);
      }
    });
  }

  // Find user arrays anywhere in an API response
  function harvestUsers(body) {
    if (!body || typeof body !== "object") return;
    if (Array.isArray(body)) {
      const looksLikeUsers = body.some(
        (x) =>
          (x && x.entityType === "USER") || (x && x.id && x.name && x.avatarUrl)
      );
      if (looksLikeUsers) cacheUsers(body);
      body.forEach(harvestUsers);
      return;
    }
    if (Array.isArray(body.recommendedUsers)) cacheUsers(body.recommendedUsers);
    if (Array.isArray(body.users)) cacheUsers(body.users);
    Object.values(body).forEach((v) => {
      if (v && typeof v === "object") harvestUsers(v);
    });
  }

  // Patch fetch to cache users from search responses
  const _originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    if (/recommendations|reviewers|user|mention|search/i.test(url)) {
      response
        .clone()
        .json()
        .then(harvestUsers)
        .catch(() => {});
    }

    return response;
  };

  function getFiber(el) {
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
    );
    return key ? el[key] : null;
  }

  // Find react-select's selectOption via React fibers
  function findSelectOption(inputEl) {
    let fiber = getFiber(inputEl);
    while (fiber) {
      const props = fiber.memoizedProps;
      if (props && typeof props.selectOption === "function") {
        return props.selectOption;
      }
      fiber = fiber.return;
    }
    return null;
  }

  // Read an option's account id from its React fiber
  function getOptionId(optionEl) {
    let fiber = getFiber(optionEl);
    for (let i = 0; i < 40 && fiber; i++) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const d = props?.data;
      if (d && typeof d === "object" && (d.id || d.account_id)) {
        return d.id || d.account_id;
      }
      fiber = fiber.return;
    }
    return null;
  }

  // Option name without the injected "+ Add" button
  function getOptionName(optionEl) {
    const clone = optionEl.cloneNode(true);
    clone.querySelector(".sr-add-btn")?.remove();
    return clone.textContent.trim();
  }

  // Return the cached API object for a clicked option
  window.addEventListener("sr-get-option-data", (e) => {
    const { idx, eventId } = e.detail;
    const optionEl = document.querySelector(
      `[role="option"][data-sr-idx="${idx}"]`
    );

    let full = null;
    if (optionEl) {
      const id = getOptionId(optionEl);
      if (id && apiDataCache.has(id)) {
        full = apiDataCache.get(id);
      } else {
        const name = getOptionName(optionEl).toLowerCase();
        full = apiDataCache.get("name:" + name) || null;
      }
    }

    window.dispatchEvent(new CustomEvent(eventId, { detail: full }));
  });

  // Bitbucket's current chips use compiled-CSS atomic classes that carry no meaning,
  // so match the semantic data-tag-text attribute first; classes are legacy fallbacks.
  const CHIP_SELECTOR = [
    '[data-tag-text="true"]',
    '[class*="MultiValueLabel"]',
    '[class*="multiValueLabel"]',
    '[class*="multi-value__label"]',
  ].join(", ");

  const normName = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // A chip may carry extra text around the name, so an exact compare is too strict —
  // but a plain substring test would treat "John" as already-present for "Johnathan".
  // Require a whole-name match instead.
  function chipHasName(chipText, name) {
    const t = normName(chipText);
    const n = normName(name);
    if (!n) return false;
    if (t === n) return true;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${esc}(\\s|,|$)`).test(t);
  }

  // Option text without the injected "+ Add" button. Cloning is expensive and this runs
  // on every mutation, so only clone when a button is actually present.
  function optionText(optionEl) {
    if (!optionEl.querySelector(".sr-add-btn")) {
      return optionEl.textContent.trim().toLowerCase();
    }
    const clone = optionEl.cloneNode(true);
    clone.querySelector(".sr-add-btn")?.remove();
    return clone.textContent.trim().toLowerCase();
  }

  // react-select's empty-result node; class-substring matched like the chips
  const NO_OPTIONS_SELECTOR =
    '[class*="NoOptionsMessage"], [class*="noOptionsMessage"], [class*="no-options"]';

  function alreadyAReviewer(name) {
    const chips = [...document.querySelectorAll(CHIP_SELECTOR)];
    if (chips.some((c) => chipHasName(c.textContent, name))) return true;

    // Sidebar rows: the name is duplicated inside a row, so read the avatar's
    // aria-labelledby target rather than the row's own text.
    return [
      ...document.querySelectorAll('[data-testid="remove-reviewer-button"]'),
    ].some((btn) => {
      const row = btn.parentElement;
      const img = row?.querySelector('[role="img"][aria-labelledby]');
      const labelled =
        img && document.getElementById(img.getAttribute("aria-labelledby"));
      return labelled ? chipHasName(labelled.textContent, name) : false;
    });
  }

  // Dropdown options, with a fallback if the role attribute ever changes
  function getOptions() {
    const byRole = [...document.querySelectorAll('[role="option"]')];
    if (byRole.length) return byRole;
    return [...document.querySelectorAll('[id*="react-select"][id*="option"]')];
  }

  // Find the reviewer input: known id, then fallbacks
  function findReviewerInput() {
    let input = document.querySelector(
      "#react-select-BitbucketPullRequestReviewers-input"
    );
    if (input) return input;

    const byId = [
      ...document.querySelectorAll('input[id^="react-select-"]'),
    ].find((i) => /review/i.test(i.id));
    if (byId) return byId;

    const labels = [
      ...document.querySelectorAll("label, h2, h3, span, div"),
    ].filter((el) => /^reviewers?$/i.test(el.textContent.trim()));
    for (const label of labels) {
      const container = label.closest("div, section, fieldset");
      const candidate = container?.querySelector(
        'input[id^="react-select-"], input[role="combobox"]'
      );
      if (candidate) return candidate;
    }
    return null;
  }

  // Type into a React-controlled input via the native setter. Clearing first matters
  // on a retry: if the value already equals what we're setting, React sees no change
  // and never re-runs the search.
  function typeIntoReactInput(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    input.focus();
    if (input.value) {
      nativeSetter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        key: value.slice(-1) || "a",
      })
    );
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || "a" })
    );
  }

  // Best match: exact, then prefix, then substring. Text is computed once per option —
  // the old version re-derived it up to three times per option on every mutation.
  function matchOption(options, target) {
    const texts = options.map(optionText);
    let i = texts.indexOf(target);
    if (i === -1) i = texts.findIndex((t) => t.startsWith(target));
    if (i === -1) i = texts.findIndex((t) => t.includes(target));
    return i === -1 ? null : options[i];
  }

  // Type the name, wait for the real option, then click it
  window.addEventListener("sr-add-reviewer", (e) => {
    const { reviewer, eventId } = e.detail;
    const respond = (detail) =>
      window.dispatchEvent(new CustomEvent(eventId, { detail }));

    const input = findReviewerInput();
    if (!input) {
      console.warn("[SR] reviewer input not found on page");
      respond({ ok: false, reason: "reviewer input not found" });
      return;
    }

    const target = reviewer.name.toLowerCase();

    // Skip if already a chip in the field. This matters for speed as much as correctness:
    // react-select hides already-selected users from the options, so a missed chip here
    // guarantees a full timeout while we wait for an option that can never appear.
    if (alreadyAReviewer(reviewer.name)) {
      respond({ ok: true, skipped: true });
      return;
    }

    let done = false;
    const finish = (detail) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(poll);
      clearInterval(retypeTimer);
      clearTimeout(timer);
      respond(detail);
    };

    // Distinguish "still waiting on the search" from "the search answered and this
    // person isn't in it" — otherwise every unfindable reviewer costs a full timeout.
    let optionsSeenAt = 0;
    let noOptionsSeenAt = 0;

    const trySelect = () => {
      if (done) return false;
      const options = getOptions();
      const match = matchOption(options, target);
      if (!match) {
        if (!options.length) {
          optionsSeenAt = 0; // menu closed or search still in flight
          // react-select renders an explicit "no options" node when a search
          // completes empty — that's a definitive answer, not a slow network
          if (document.querySelector(NO_OPTIONS_SELECTOR)) {
            if (!noOptionsSeenAt) {
              noOptionsSeenAt = Date.now();
            } else if (Date.now() - noOptionsSeenAt > 1500) {
              console.warn(
                `[SR] search returned no results for "${reviewer.name}"`
              );
              finish({
                ok: false,
                reason: `"${reviewer.name}" not found in search results`,
              });
            }
          } else {
            noOptionsSeenAt = 0;
          }
        } else if (!optionsSeenAt) {
          optionsSeenAt = Date.now(); // results arrived; give them a moment to settle
        } else if (Date.now() - optionsSeenAt > 2000) {
          console.warn(`[SR] "${reviewer.name}" is not in the search results`);
          finish({
            ok: false,
            reason: `"${reviewer.name}" not found in search results`,
          });
        }
        return false;
      }
      // react-select selects on mousedown
      match.scrollIntoView({ block: "nearest" });
      match.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );
      match.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );
      match.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
      );
      finish({ ok: true });
      return true;
    };

    // Coalesce bursts of mutations into one check. Deliberately NOT
    // requestAnimationFrame: that stops firing in a background tab, so switching
    // tabs mid-apply would stall the search until it timed out.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued || done) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        trySelect();
      }, 16);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Safety net: don't depend solely on mutations reaching us
    const poll = setInterval(trySelect, 300);

    // Bitbucket's user search is a network round-trip and sometimes never fires
    // (input debounce, a lost focus, a dropped request). Re-type periodically
    // rather than waiting out the whole timeout on a search that never happened.
    const retypeTimer = setInterval(() => {
      if (done) return;
      console.info(`[SR] re-triggering search for "${reviewer.name}"`);
      typeIntoReactInput(input, reviewer.name);
    }, 2500);

    const timer = setTimeout(() => {
      console.warn(
        `[SR] no dropdown option matched "${reviewer.name}" within timeout`
      );
      finish({
        ok: false,
        reason: `no dropdown option matched "${reviewer.name}"`,
      });
    }, 10000);

    // Trigger Bitbucket's user search
    typeIntoReactInput(input, reviewer.name);

    // Options may already be present
    trySelect();
  });
})();
