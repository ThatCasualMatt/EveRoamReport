// TODO:
//  - Input validation.
//  - Abuse prevention and rate limiting (may require backend/caching).
//  - Custom output formatting:
//      - Custom number formatting for isk values.
//  - Other roam metrics:
//      - Damage?
//      - Member participation on kills?
//      - Time?
//      - Corps/Alliances involved?
//      - Losses/Corp?
//      - Ship kill/loss count?
//      - Uni members involved?
//  - Manually add kills?
//  - Other forms of editing?
//  - Ship icons?
//  - Detect missing fleet members?
//  - Permalinks to roam reports?
//  - Additional visualisations?
//      - Visual timeline?
//      - Parallel tracks for different systems?
//      - Show deaths on grid
//  - Detect if browser is supported (Fetch API not supported in IE).

// ---------------------------------------------------------------------------
// #12 — Named module-level constants (maxZkillKills was buried inside a function)
// ---------------------------------------------------------------------------
const ZKILL_PAGE_SIZE       = 1000;
const ESI_BATCH_SIZE        = 1000;
const ESI_KILL_CONCURRENCY  = 10;   // max simultaneous ESI killmail fetches
const ESI_KILL_BATCH_DELAY  = 100;  // ms pause between ESI fetch batches

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
window.knownTypes     = {};
window.knownKillData  = {};
window.partialKillData = {};
// window.characters[id]: {name, alliance, corp, isFriendly, shipsFlown}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function make_request_params(kind, body) {
  if (kind === "names_batch" || kind === "esi_ids") {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    };
  }
  if (kind === "zkill_batch") {
    return {
      method: "GET",
      mode: "cors",
      headers: {
        "Accept-Encoding": "gzip",
        "User-Agent": "EveRoamReport https://roamreport.unfinishedprojects.xyz",
      },
    };
  }
  if (kind === "esi_kill_data") {
    return {
      method: "GET",
      headers: { "Content-Type": "application/json", accept: "application/json" },
    };
  }
}

function get_url(kind, args) {
  if (kind === "names_batch")
    return "https://esi.evetech.net/v1/universe/ids/?datasource=tranquility";
  if (kind === "esi_ids")
    return "https://esi.evetech.net/v3/universe/names/?datasource=tranquility";
  if (kind === "zkill_batch")
    // #11 — Fixed typo: querryType -> queryType
    return `https://zkillboard.com/api/${args.queryType}/${args.id}/pastSeconds/604800/page/${args.page}/`;
  if (kind === "esi_kill_data")
    return `https://esi.evetech.net/v1/killmails/${args.killmail_id}/${args.killmail_hash}/`;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

// #4 — Surface errors in the UI instead of only logging to the console
function show_error(message) {
  let banner = document.getElementById("error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "error-banner";
    banner.className = "error-banner";
    document.querySelector(".page-container").prepend(banner);
  }
  banner.textContent = "⚠ " + message;
  banner.style.display = "block";
  console.error(message);
}

function hide_error() {
  const banner = document.getElementById("error-banner");
  if (banner) banner.style.display = "none";
}

// #3 — Show live progress during ESI kill fetching
function update_progress(current, total) {
  const el = document.getElementById("fetch-progress");
  if (!el) return;
  if (total === 0) {
    el.textContent = "";
    el.style.display = "none";
    return;
  }
  el.textContent = `Fetching kill data: ${current} / ${total}`;
  el.style.display = "block";
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------
function kill_sort(a, b) {
  if (a.date > b.date) return  1;
  if (a.date === b.date) return 0;
  return -1;
}

function char_alpha_sort(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------
function get_date(str) {
  let date = new Date(str);
  // Firefox date parsing workaround
  if (
    Object.prototype.toString.call(date) !== "[object Date]" ||
    isNaN(date.getTime())
  ) {
    str = str.replace(/\./g, "-");
    str = str.replace(/ /, "T").substring(0, 19) + ".000Z";
    date = new Date(str);
  }
  return date;
}

// Converts ESI ISO timestamp "2024-03-15T14:32:07Z" -> "2024-03-15  14:32:07"
function format_killmail_time(isoStr) {
  if (!isoStr) return "";
  return isoStr.slice(0, 10) + "  " + isoStr.slice(11, 19);
}

// ---------------------------------------------------------------------------
// Kill validation helpers
// ---------------------------------------------------------------------------
function get_kill_by_id(id, killList) {
  for (let i = 0; i < killList.length; ++i) {
    if (killList[i].killmail_id === id) return killList[i];
  }
  return undefined;
}

function is_valid_kill(kill) {
  if (window.friendlies.has(kill.victim.character_id)) return true;
  for (const attacker of kill.attackers) {
    if (window.friendlies.has(attacker.character_id)) return true;
  }
  return false;
}

function is_kill_in_time_window(kill) {
  if (!kill.killmail_time) return true;
  const killDate = get_date(kill.killmail_time);
  if (window.roamStartDate && killDate < window.roamStartDate) return false;
  if (window.roamEndDate   && killDate > window.roamEndDate)   return false;
  return true;
}

function mark_missing_type(id, isCharacter) {
  if (id === undefined) return;
  if (!isCharacter) {
    // #1 — Solar system IDs now flow through this same pipeline.
    //      ESI /universe/names/ returns category "solar_system" and stores
    //      the name in knownTypes, so data.js is no longer needed.
    if (!window.knownTypes[id] && window.unknownTypes.indexOf(id) === -1)
      window.unknownTypes.push(id);
  } else {
    if (window.characters[id] === undefined)
      window.unknownTypes.push(id);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function get_roam() {
  hide_error();

  const loader   = document.getElementsByClassName("loader")[0];
  loader.style.display = "inherit";

  const elem     = document.getElementsByName("names")[0];
  const nameList = elem.value.split("\n");

  window.finalNames      = [];
  window.killIDs         = [];
  window.unsortedKills   = [];
  window.friendlies      = new Set();
  window.characters      = {};
  window.knownTypes      = {};   // reset so stale ship/system names don't persist across runs
  window.knownKillData   = {};   // reset so pagination state doesn't carry over
  window.partialKillData = {};
  window.unknownTypes    = [];

  const charNameRegex1 = /\[ ([\d\. :]+) \] ([ a-zA-Z0-9-']{3,37}) > /;
  const charNameRegex2 = /^\s*([ a-zA-Z0-9-']{3,37})\s*$/;

  let startDate;
  let endDate;

  for (let i = 0; i < nameList.length; ++i) {
    const line = nameList[i].trim();
    let name;
    let match;

    if ((match = charNameRegex1.exec(line)) !== null) {
      name = match[2].trim();
      const date = get_date(match[1] + " GMT");
      if (startDate === undefined || date < startDate) startDate = date;
      if (endDate   === undefined || date > endDate)   endDate   = date;
    } else if ((match = charNameRegex2.exec(line)) !== null) {
      name = match[1].trim();
    }

    if (name && name !== "EVE System" && window.finalNames.indexOf(name) === -1) {
      window.finalNames.push(name);
    }
  }

  const now       = get_date(Date.now());
  const threshold = new Date(now.getTime() - 60 * 60000);

  if (endDate > threshold) {
    const diff   = endDate - threshold;
    const result = window.confirm(
      `WARNING! It can take up to 60 minutes to ensure zkill gets all the kills. ` +
      `We recommend you wait another ${Math.ceil(diff / 60000)} minutes before using this tool.\n\n` +
      `Are you sure you wish to continue?`
    );
    if (!result) {
      loader.style.display = "none";
      return;
    }
  }

  endDate.setHours(endDate.getHours() + 1);

  // Store Date objects for client-side kill window filtering
  window.roamStartDate = new Date(startDate.getTime() - 60 * 60 * 1000); // 1h buffer
  window.roamEndDate   = endDate;

  console.log("Players involved:", window.finalNames);

  request_ids_for_names(window.finalNames, true)
    // #6 — Query per characterID; avoids fetching entire corp/alliance history.
    //       Affiliation fetch removed — corp/alliance grouping no longer used,
    //       so fetching affiliations was pure wasted API calls, especially for
    //       NPSI fleets with many different corps represented.
    .then(() => request_all_kills_by_character([...window.friendlies]))
    .then(() => request_full_kill_data(window.partialKillData))
    .then(() => request_names_for_ids(window.unknownTypes))
    .then(() => process_kills())
    .catch((error) => {
      // #4 — Show error in UI
      show_error("Something went wrong: " + error.message);
      loader.style.display = "none";
      update_progress(0, 0);
    });
}

// ---------------------------------------------------------------------------
// ESI: character name -> ID
// ---------------------------------------------------------------------------
function request_ids_for_names(names, addToFriendlies) {
  // #8 — esiIdCountLimit was accidentally global
  const deduped  = Array.from(new Set(names));
  const requests = [];
  for (let start = 0; start < deduped.length; start += ESI_BATCH_SIZE) {
    requests.push(request_ids_for_names_batch(deduped.slice(start, start + ESI_BATCH_SIZE), addToFriendlies));
  }
  return Promise.all(requests);
}

function request_ids_for_names_batch(names, addToFriendlies) {
  const url        = get_url("names_batch");
  const url_params = make_request_params("names_batch", names);

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status !== 200)
        throw new Error("ESI /universe/ids/ request failed (status " + response.status + ")");
      return response.json();
    })
    .then((jsonData) => {
      const chars = jsonData.characters || [];
      for (const char of chars) {
        window.characters[char.id] = { name: char.name, isFriendly: addToFriendlies, shipsFlown: [] };
        if (addToFriendlies) window.friendlies.add(char.id);
      }
      console.log("Got batch of character IDs:", chars.length);
    });
}

// ---------------------------------------------------------------------------
// ESI: ID -> name (handles characters, ships, AND solar systems)
// #1 — Adding "solar_system" handling here means data.js is no longer needed
// ---------------------------------------------------------------------------
function request_names_for_ids(IDs) {
  // #8 — IDs was accidentally global
  const deduped  = Array.from(new Set(IDs));
  const requests = [];
  for (let start = 0; start < deduped.length; start += ESI_BATCH_SIZE) {
    requests.push(request_names_for_ids_batch(deduped.slice(start, start + ESI_BATCH_SIZE)));
  }
  return Promise.all(requests);
}

function request_names_for_ids_batch(IDs) {
  const url        = get_url("esi_ids");
  const url_params = make_request_params("esi_ids", IDs);

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status !== 200)
        throw new Error("ESI /universe/names/ request failed (status " + response.status + ")");
      return response.json();
    })
    .then((jsonData) => {
      for (const item of jsonData) {
        if (item.category === "character") {
          // Don't overwrite friendlies already stored with full data
          if (!window.characters[item.id]) {
            window.characters[item.id] = { name: item.name, isFriendly: false, shipsFlown: [] };
          }
        } else {
          // Covers inventory_type (ships), solar_system, station, etc.
          window.knownTypes[item.id] = item.name;
        }
      }
      console.log("Got batch of names:", jsonData.length);
    });
}

// ---------------------------------------------------------------------------
// zKillboard: fetch kill stubs
// #6 — Replaced corp/alliance grouping logic with per-character queries.
//      The old approach could fetch thousands of irrelevant kills when any
//      two fleet members happened to share a large corp or alliance.
//      Per-character queries are more targeted and reliably scoped.
// ---------------------------------------------------------------------------
function request_all_kills_by_character(characterIDs) {
  const requests = characterIDs.map((id) => request_kill_batch(id, "characterID", 1));
  return Promise.all(requests);
}

function request_kill_batch(id, queryType, page) {
  // #11 — Fixed typo: querryType -> queryType throughout
  const url        = get_url("zkill_batch", { queryType, id, page });
  const url_params = make_request_params("zkill_batch");

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status !== 200)
        throw new Error("zKill API request failed (status " + response.status + ")");
      return response.json();
    })
    .then((zkillData) => {
      for (const stub of zkillData) {
        if (!window.knownKillData[stub.killmail_id]) {
          window.partialKillData[stub.killmail_id] = stub;
        }
      }
      console.log(`zKill: ${zkillData.length} kills for ${queryType}/${id} page ${page}`);
      // #12 — ZKILL_PAGE_SIZE is now a named constant at the top of the file
      if (zkillData.length === ZKILL_PAGE_SIZE)
        return request_kill_batch(id, queryType, page + 1);
    });
}

// ---------------------------------------------------------------------------
// ESI: fetch full killmail data
// #2 — Rate-limited: ESI_KILL_CONCURRENCY fetches at a time with a small delay
//      between batches, preventing ESI's error-rate limiter from triggering on
//      large fleets where hundreds of kills might need fetching at once.
// #3 — Reports live progress to the UI during fetching.
// ---------------------------------------------------------------------------
async function request_full_kill_data(partialKillData) {
  const toFetch = [];

  for (const id in partialKillData) {
    if (partialKillData[id].victim !== undefined) {
      // Full data already cached from a previous processing run
      enqueue_kill_result(partialKillData[id]);
    } else {
      toFetch.push({ id, hash: partialKillData[id].zkb.hash });
    }
  }

  const total  = toFetch.length;
  let   fetched = 0;
  update_progress(fetched, total);

  for (let i = 0; i < toFetch.length; i += ESI_KILL_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ESI_KILL_CONCURRENCY);

    const results = await Promise.all(batch.map(({ id, hash }) => {
      const url        = get_url("esi_kill_data", { killmail_id: id, killmail_hash: hash });
      const url_params = make_request_params("esi_kill_data");
      return fetch(new Request(url, url_params))
        .then((response) => {
          if (response.status !== 200)
            throw new Error("ESI killmail fetch failed for " + id + " (status " + response.status + ")");
          return response.json();
        });
    }));

    for (const result of results) {
      enqueue_kill_result(result);
    }

    fetched += batch.length;
    update_progress(fetched, total);

    if (i + ESI_KILL_CONCURRENCY < toFetch.length)
      await new Promise((resolve) => setTimeout(resolve, ESI_KILL_BATCH_DELAY));
  }

  update_progress(0, 0);
}

function enqueue_kill_result(esiData) {
  // #8 — r and kill were accidentally global in the old Promise.all() loop
  const kill = window.partialKillData[esiData.killmail_id];
  if (!kill) return;

  kill.attackers       = esiData.attackers;
  kill.solar_system_id = esiData.solar_system_id;
  kill.victim          = esiData.victim;
  kill.moon_id         = esiData.moon_id;
  kill.war_id          = esiData.war_id;
  kill.killmail_time   = esiData.killmail_time;
  window.knownKillData[esiData.killmail_id] = kill;

  if (window.killIDs.indexOf(kill.killmail_id) >= 0) return;
  if (!is_valid_kill(kill)) return;

  kill.date = get_date(kill.killmail_time);
  if (!is_kill_in_time_window(kill)) return;

  const v = kill.victim;
  mark_missing_type(v.ship_type_id, false);
  mark_missing_type(v.character_id, true);
  // #1 — Queue solar system ID for ESI resolution (replaces data.js static lookup)
  mark_missing_type(kill.solar_system_id, false);

  for (const attacker of kill.attackers) {
    if (attacker.final_blow) mark_missing_type(attacker.character_id, true);
    mark_missing_type(attacker.ship_type_id, false);
  }

  window.killIDs.push(kill.killmail_id);
  window.unsortedKills.push(kill);
}

// ---------------------------------------------------------------------------
// Build kill display table
// ---------------------------------------------------------------------------
function process_kills() {
  console.log("Processing kills...");

  window.workingKillSet = window.unsortedKills.sort(kill_sort);

  const table = document.getElementsByName("killdisplay")[0];
  table.innerHTML =
    '<div class="krh">' +
    '<div class="kh">New fight?</div>' +
    '<div class="kh">Time</div>' +
    '<div class="kh">Kill/Loss</div>' +
    '<div class="kh">Ship</div>' +
    '<div class="kh">Victim</div>' +
    '<div class="kh">Final Blow</div>' +
    '<div class="kh">Location</div>' +
    '<div class="kh">ISK</div>' +
    '</div>';

  for (let i = 0; i < window.workingKillSet.length; ++i) {
    const kill        = window.workingKillSet[i];
    const is_friendly = window.friendlies.has(kill.victim.character_id);

    const row = document.createElement("div");
    row.className = "kr-on";
    row.name      = kill.killmail_id;
    table.appendChild(row);

    kill.display_row    = row;
    kill.is_friendly    = is_friendly;
    kill.is_included    = true;
    kill.is_fight_start = i === 0 || kill.date - window.workingKillSet[i - 1].date > 5 * 60 * 1000;

    // — New fight? checkbox —
    const checkCell = document.createElement("div");
    checkCell.className = "kd";
    checkCell.innerHTML = `<input type="checkbox" id="${kill.killmail_id}">`;
    row.appendChild(checkCell);

    kill.is_fight_start_check_box         = checkCell.children[0];
    kill.is_fight_start_check_box.checked = kill.is_fight_start;

    kill.is_fight_start_check_box.addEventListener("change", (event) => {
      const k = get_kill_by_id(parseInt(event.target.id), window.workingKillSet);
      k.is_fight_start = event.target.checked;
      update_kill_display(k);
    });
    kill.is_fight_start_check_box.addEventListener("mousedown", (e) => e.stopPropagation());
    kill.is_fight_start_check_box.addEventListener("touchdown",  (e) => e.stopPropagation());

    // — Time (linked to zKill) —
    const timeCell = document.createElement("div");
    timeCell.className = "kd";
    timeCell.innerHTML =
      `<a href="https://zkillboard.com/kill/${kill.killmail_id}/" target="_blank">` +
      format_killmail_time(kill.killmail_time) +
      "</a>";
    row.appendChild(timeCell);
    kill.zkill_href = timeCell.children[0];
    kill.zkill_href.addEventListener("mousedown", (e) => e.stopPropagation());
    kill.zkill_href.addEventListener("touchdown",  (e) => e.stopPropagation());

    // — Kill / Loss —
    const typeCell = document.createElement("div");
    typeCell.className = "kd";
    typeCell.appendChild(document.createTextNode(is_friendly ? "Loss" : "Kill"));
    row.appendChild(typeCell);

    // — Ship —
    const shipCell = document.createElement("div");
    shipCell.className = "kd";
    shipCell.appendChild(document.createTextNode(window.knownTypes[kill.victim.ship_type_id] || "Unknown Type"));
    row.appendChild(shipCell);

    // — Victim —
    const victimCell = document.createElement("div");
    victimCell.className = "kd";
    const pilotName = kill.victim.character_id && window.characters[kill.victim.character_id]
      ? window.characters[kill.victim.character_id].name : "";
    victimCell.appendChild(document.createTextNode(pilotName));
    row.appendChild(victimCell);

    // — Final Blow —
    const fbCell     = document.createElement("div");
    fbCell.className = "kd";
    const fbAttacker = kill.attackers.find((x) => x.final_blow);
    const fbChar     = fbAttacker && window.characters[fbAttacker.character_id];
    fbCell.appendChild(document.createTextNode(fbChar ? fbChar.name : ""));
    row.appendChild(fbCell);

    // — Location —
    // #1 — Reads from knownTypes (resolved via ESI), replacing the data.js lookup
    const locCell = document.createElement("div");
    locCell.className = "kd";
    const systemName = (window.knownTypes && window.knownTypes[kill.solar_system_id])
      ? window.knownTypes[kill.solar_system_id]
      : "sysId_" + kill.solar_system_id;
    locCell.appendChild(document.createTextNode(systemName));
    row.appendChild(locCell);

    // — ISK —
    const iskCell = document.createElement("div");
    iskCell.className = "kd";
    iskCell.appendChild(document.createTextNode(
      Math.round(kill.zkb.totalValue / 10000) / 100 + "m"
    ));
    row.appendChild(iskCell);

    update_kill_display(kill);
  }

  document.getElementsByClassName("loader")[0].style.display = "none";
  document.getElementsByClassName("step-two")[0].style.display = "inherit";
}

// ---------------------------------------------------------------------------
// Kill row styling
// ---------------------------------------------------------------------------
function update_kill_display(kill) {
  kill.is_fight_start_check_box.checked = kill.is_fight_start;
  kill.display_row.style.borderTop = kill.is_fight_start ? "solid 2px #ccc" : "0px";

  if (kill.is_included) {
    kill.display_row.className   = "kr-on";
    kill.display_row.style.color = kill.is_friendly ? "red" : "green";
  } else {
    kill.display_row.className   = "kr-off";
    kill.display_row.style.color = "#aaa";
  }
}

// ---------------------------------------------------------------------------
// Generate AAR output
// ---------------------------------------------------------------------------
function get_forum_post() {
  for (const key in window.characters) {
    window.characters[key].shipsFlown = [];
  }

  for (const kill of window.workingKillSet) {
    if (!kill.is_included) continue;

    const v = kill.victim;
    if (v.character_id !== undefined && window.characters[v.character_id] !== undefined) {
      if (!window.characters[v.character_id].shipsFlown.includes(v.ship_type_id))
        window.characters[v.character_id].shipsFlown.push(v.ship_type_id);
    }

    for (const attacker of kill.attackers) {
      if (attacker.character_id !== undefined && window.characters[attacker.character_id] !== undefined) {
        if (!window.characters[attacker.character_id].shipsFlown.includes(attacker.ship_type_id))
          window.characters[attacker.character_id].shipsFlown.push(attacker.ship_type_id);
      }
    }
  }

  // #9 — Use === true instead of == 1 for the isFriendly boolean check
  const sortedCharacters = Object.values(window.characters)
    .filter((x) => x.isFriendly === true)
    .sort(char_alpha_sort);

  const templateName = document.getElementsByName("template")[0].value;
  const template     = window.templates[templateName];

  const lines = [];
  lines.push(template.header());
  lines.push(template.membersHeader(window.finalNames.length));

  for (const char of sortedCharacters) {
    const shipList = char.shipsFlown
      .map((id) => window.knownTypes[id])
      .filter((name) => name !== undefined && !name.includes("Capsule"));
    lines.push(template.member(char.name, shipList));
  }

  lines.push(template.membersFooter());
  lines.push(template.killsHeader());

  let iskGain     = 0;
  let iskLoss     = 0;
  let addSeparator = true;

  for (let i = 0; i < window.workingKillSet.length; ++i) {
    const kill = window.workingKillSet[i];
    if (kill.is_fight_start) addSeparator = true;
    if (!kill.is_included) continue;

    const shipName = window.knownTypes[kill.victim.ship_type_id] || "Unknown Type";

    if (addSeparator) {
      const systemIDs = [kill.solar_system_id];
      for (let j = i + 1; j < window.workingKillSet.length; ++j) {
        const kk = window.workingKillSet[j];
        if (kk.is_fight_start) break;
        if (kk.is_included && systemIDs.indexOf(kk.solar_system_id) === -1)
          systemIDs.push(kk.solar_system_id);
      }
      // #1 — System names now from knownTypes (ESI), not data.js
      const regionNames = systemIDs.map((x) =>
        (window.knownTypes && window.knownTypes[x]) ? window.knownTypes[x] : "sysId_" + x
      );
      lines.push(template.killListSeparator(kill.killmail_time.slice(11, 19), regionNames));
      addSeparator = false;
    }

    const zkillUrl   = `https://zkillboard.com/kill/${kill.killmail_id}/`;
    const zkillValue = Math.round(kill.zkb.totalValue / 10000) / 100;

    if (kill.is_friendly) {
      lines.push(template.loss(zkillUrl, shipName, zkillValue));
      iskLoss += kill.zkb.totalValue;
    } else {
      lines.push(template.kill(zkillUrl, shipName, zkillValue));
      iskGain += kill.zkb.totalValue;
    }
  }

  lines.push(template.killsFooter());
  lines.push(template.statsHeader());
  lines.push(template.stats(iskGain, iskLoss));
  lines.push(template.statsFooter());
  lines.push(template.footer());

  // ---------------------------------------------------------------------------
  // Insert Discord message-break markers
  // Read the character limit from the Nitro toggle, then walk the lines array
  // and insert a visible separator whenever adding the next line would push the
  // running count over the limit. Never splits mid-line — messages may be
  // slightly under the limit rather than over.
  // ---------------------------------------------------------------------------
  const nitro      = document.getElementById("nitro-toggle").checked;
  const charLimit  = nitro ? 4000 : 2000;
  const BREAK_LINE = "─────────────── ✂ MESSAGE BREAK ───────────────";

  const output  = [];
  let msgLen    = 0;
  let msgIsEmpty = true; // true at the start of each new message

  for (const line of lines) {
    // Cost of adding this line: its characters plus the \n separator before it
    // (no separator before the very first line in each message)
    const lineCost = line.length + (msgIsEmpty ? 0 : 1);

    if (!msgIsEmpty && msgLen + lineCost > charLimit) {
      // Adding this line would exceed the limit — insert break first.
      // Note: if a single line is itself longer than charLimit it will still be
      // placed in its own message — we never split mid-line.
      output.push(BREAK_LINE);
      msgLen    = BREAK_LINE.length + 1; // break line costs its length + its \n
      msgIsEmpty = true;
    }

    output.push(line);
    msgLen    += line.length + (msgIsEmpty ? 0 : 1);
    msgIsEmpty = false;
  }

  document.getElementsByName("output")[0].value = output.join("\n");
}

// ---------------------------------------------------------------------------
// Mouse / touch interaction for kill table
// ---------------------------------------------------------------------------
let mouseDown    = false;
let previousRow  = undefined;
let enablingRows = false;

function kills_mouse_down(event) {
  event.preventDefault();
  let row = event.target;
  if (row.tagName === "a" || row.tagName === "input") return;

  while (row && row.className !== "kr-on" && row.className !== "kr-off")
    row = row.parentElement;

  if (row) {
    // #8 — kill was accidentally global here
    const kill   = get_kill_by_id(parseInt(row.name), window.workingKillSet);
    enablingRows = !kill.is_included;
    mouseDown    = true;
    previousRow  = undefined;
    kills_update_include_state(event);
  }
}

function kills_update_include_state(event) {
  if (!mouseDown) return;
  let row = event.target;
  while (row && row.className !== "kr-on" && row.className !== "kr-off")
    row = row.parentElement;
  if (row && row !== previousRow) {
    // #8 — kill was accidentally global here
    const kill   = get_kill_by_id(parseInt(row.name), window.workingKillSet);
    kill.is_included = enablingRows;
    update_kill_display(kill);
    previousRow = row;
  }
}

function window_mouse_up() {
  mouseDown = false;
}

// ---------------------------------------------------------------------------
// File drop handler
// ---------------------------------------------------------------------------
function window_drop(event) {
  if (event.dataTransfer.files.length === 0) return;
  if (event.dataTransfer.files[0].type !== "text/plain") return;
  // #8 — reader was accidentally global
  const reader = new FileReader();
  reader.readAsText(event.dataTransfer.files[0]);
  reader.onloadend = () => {
    document.getElementsByName("names")[0].value = reader.result;
  };
}

function prevent_defaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.onload = () => {
  const table = document.getElementsByName("killdisplay")[0];
  table.addEventListener("mousedown", kills_mouse_down);
  table.addEventListener("touchdown", kills_mouse_down);
  table.addEventListener("mousemove", kills_update_include_state);
  table.addEventListener("touchmove", kills_update_include_state);
  document.addEventListener("mouseup",   window_mouse_up);
  document.addEventListener("touchend",  window_mouse_up);
  document.addEventListener("drop",      prevent_defaults, false);
  document.addEventListener("dragenter", prevent_defaults, false);
  document.addEventListener("dragover",  prevent_defaults, false);
  document.addEventListener("dragleave", prevent_defaults, false);
  document.addEventListener("drop",      window_drop);
};