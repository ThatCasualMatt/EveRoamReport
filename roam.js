// TODO:
//  - Input validation.
//  - Abuse prevention and rate limiting (may require backend/caching).
//  - Custom output formatting:
//      - Different forum post templates.
//      - Custom number formatting for isk values.
//  - Other roam metrics>
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
//      - visual timeline?
//      - parallel tracks for different systems?
//      - show deaths on grid
//  - Detect if browser is supported (obviously, Fetch API is not supported in IE).

window.knownTypes = {};
window.knownKillData = {};
window.partialKillData = {};
// window.characters[id]: {name:string, alliance:id, corp:id, isFriendly:bool, shipsFlown:[id]}

request_params = {
  names_batch: {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
    },
  },
  esi_ids: {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
    },
  },
  esi_affiliations: {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
    },
  },
  zkill_batch: {
    method: "GET",
    mode: "cors",
    headers: {
      "Accept-Encoding": "gzip",
    },
  },
  esi_kill_data: {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      accept: "application/json",
    },
  },
};

function get_url(kind, args) {
  if (kind == "names_batch")
    return "https://esi.evetech.net/v1/universe/ids/?datasource=tranquility";
  if (kind == "esi_ids")
    return "https://esi.evetech.net/v3/universe/names/?datasource=tranquility";
  if (kind == "esi_affiliations")
    return "https://esi.evetech.net/v1/characters/affiliation/?datasource=tranquility";
  if (kind == "zkill_batch")
    return `https://zkillboard.com/api/${args.querryType}/${args.id}/pastSeconds/172800/page/${args.page}/`;
  if (kind == "esi_kill_data")
    return `https://esi.evetech.net/v1/killmails/${args.killmail_id}/${args.killmail_hash}/`;
}

function numeric_sort(a, b) {
  return a - b;
}

function affiliation_sort(a, b) {
  char_a = window.characters[a];
  char_b = window.characters[b];
  if (char_a.alliance === char_b.alliance) return char_a.corp - char_b.corp;
  if (char_a.alliance === undefined) return -1;
  if (char_b.alliance === undefined) return 1;
  return char_a.alliance - char_b.alliance;
}

function kill_sort(a, b) {
  if (a.date > b.date) return 1;
  if (a.date == b.date) return 0;
  return -1;
}

function char_alpha_sort(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function get_date(str) {
  var date = new Date(str);
  // Firefox date parsing workaround.
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

function get_kill_by_id(id, killList) {
  for (var i = 0; i < killList.length; ++i) {
    if (killList[i].killmail_id == id) return killList[i];
  }
  return undefined;
}

function is_valid_kill(kill) {
  if (window.friendlies.has(kill.victim.character_id)) return true;

  for (var j = 0; j < kill.attackers.length; ++j) {
    var attacker = kill.attackers[j];
    if (window.friendlies.has(attacker.character_id)) return true;
  }
  return false;
}

function mark_missing_type(id, isCharacter) {
  if (id === undefined) return;

  if (
    !isCharacter &&
    !window.knownTypes[id] &&
    window.unknownTypes.indexOf(id) == -1
  ) {
    window.unknownTypes.push(id);
  } else if (isCharacter && window.characters[id] === undefined) {
    window.unknownTypes.push(id);
  }
}

function get_roam() {
  var loader = document.getElementsByClassName("loader")[0];
  loader.style.display = "inherit";

  var elem = document.getElementsByName("names")[0];
  var nameList = elem.value.split("\n");
  window.finalNames = [];
  window.killIDs = [];
  window.unsortedKills = [];
  window.friendlies = new Set();
  window.characters = {};
  window.partialKillData = {};
  window.unknownTypes = [];
  var charNameRegex1 = /\[ ([\d\. :]+) \] ([ a-zA-Z0-9-']{3,37}) > /;
  var charNameRegex2 = /^\s*([ a-zA-Z0-9-']{3,37})\s*$/;

  window.starttime = undefined;
  window.endtime = undefined;
  var startDate = undefined;
  var endDate = undefined;

  for (var i = 0; i < nameList.length; ++i) {
    var line = nameList[i].trim();
    var name = undefined;
    var match = undefined;

    if ((match = charNameRegex1.exec(line)) !== null) {
      name = match[2].trim();
      var date = get_date(match[1] + " GMT");
      if (startDate === undefined || date < startDate) startDate = date;
      if (endDate === undefined || date > endDate) endDate = date;
    } else if ((match = charNameRegex2.exec(line)) !== null) {
      name = match[1].trim();
    }

    // If the player named "EVE System" ever becomes active, this script will no longer be accurate.
    if (name && name != "EVE System" && window.finalNames.indexOf(name) == -1) {
      window.finalNames.push(name);
    }
  }

  var now = get_date(Date.now());
  var threshold = new Date(now.getTime() - 60 * 60000);
  var diff = endDate - threshold;
  if (endDate > threshold) {
    var result = window.confirm(
      `WARNING! It can take up to 60 minutes to ensure zkill gets all the kills. We recommend you wait another ${Math.ceil(
        diff / 60000
      )} minutes before using this tool.\n\nAre you sure you wish to continue?`
    );

    if (!result) {
      var loader = document.getElementsByClassName("loader")[0];
      loader.style.display = "none";
      return;
    }
  }

  endDate.setHours(endDate.getHours() + 1);
  window.starttime = startDate.toISOString().replace(/[-T]/g, "").slice(0, 10);
  window.endtime = endDate.toISOString().replace(/[-T]/g, "").slice(0, 10);

  console.log("Players involved:" + window.finalNames);

  request_ids_for_names(window.finalNames, true)
    .then(() => {
      return request_affiliations_for_unknown_characters();
    })
    .then(() => {
      return request_all_kills([...window.friendlies]);
    })
    .then(() => {
      return request_full_kill_data(window.partialKillData);
    })
    .then((args) => {
      return request_names_for_ids(window.unknownTypes);
    })
    .then((args) => {
      process_kills();
    })
    .catch((error) => {
      console.error(error);
      var loader = document.getElementsByClassName("loader")[0];
      loader.style.display = "none";
    });
}

function request_ids_for_names(names, addToFriendlies) {
  esiIdCountLimit = 1000;

  names = Array.from(new Set(names));
  var count = names.length;
  var requests = [];
  for (var start = 0; start < count; start = start + esiIdCountLimit) {
    var batch = names.slice(start, start + esiIdCountLimit);
    requests.push(request_ids_for_names_batch(batch, addToFriendlies));
  }
  return Promise.all(requests);
}

function request_ids_for_names_batch(names, addToFriendlies) {
  url = get_url("names_batch");
  url_params = request_params.names_batch;
  url_params.body = JSON.stringify(names);

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status != 200)
        throw new Error("API request failed to get list of character IDs");
      return response.json();
    })
    .then((jsonData) => {
      if (jsonData.characters === undefined) jsonData.characters = [];

      var chars = jsonData.characters;
      for (var i = 0; i < chars.length; ++i) {
        window.characters[chars[i].id] = {
          name: chars[i].name,
          isFriendly: addToFriendlies,
          shipsFlown: [],
        };
        if (addToFriendlies) window.friendlies.add(chars[i].id);
      }

      console.log("Got batch of character IDs");
    });
}

function request_names_for_ids(IDs) {
  esiIdCountLimit = 1000;

  IDs = Array.from(new Set(IDs));
  var count = IDs.length;
  var requests = [];
  for (var start = 0; start < count; start = start + esiIdCountLimit) {
    var batch = IDs.slice(start, start + esiIdCountLimit);
    requests.push(request_names_for_ids_batch(batch));
  }
  return Promise.all(requests);
}

function request_names_for_ids_batch(IDs) {
  url = get_url("esi_ids");
  url_params = request_params.esi_ids;
  url_params.body = JSON.stringify(IDs);

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status != 200)
        throw new Error("API request failed to get list of character IDs");
      console.log("Got batch of missing names");
      return response.json();
    })
    .then((jsonData) => {
      for (var i = 0; i < jsonData.length; ++i) {
        if (jsonData[i].category == "character") {
          window.characters[jsonData[i].id] = {
            name: jsonData[i].name,
            isFriendly: false,
            shipsFlown: [],
          };
        } else {
          window.knownTypes[jsonData[i].id] = jsonData[i].name;
        }
      }
    });
}

function request_affiliations_for_unknown_characters() {
  esiIdCountLimit = 1000;

  unknownCharacters = [];
  for (var key in window.characters) {
    if (window.characters[key].corporation_id === undefined)
      unknownCharacters.push(key);
  }

  IDs = Array.from(new Set(unknownCharacters));
  var count = IDs.length;
  var requests = [];
  for (var start = 0; start < count; start = start + esiIdCountLimit) {
    var batch = IDs.slice(start, start + esiIdCountLimit);
    requests.push(request_affiliations_for_char_ids_batch(batch));
  }
  return Promise.all(requests);
}

function request_affiliations_for_char_ids_batch(IDs) {
  url = get_url("esi_affiliations");
  url_params = request_params.esi_affiliations;
  url_params.body = JSON.stringify(IDs);

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status != 200)
        throw new Error("API request failed to get list of character IDs");
      console.log("Got batch of missing names");
      return response.json();
    })
    .then((jsonData) => {
      for (var i = 0; i < jsonData.length; ++i) {
        var entry = jsonData[i];
        window.characters[entry.character_id].corp = entry.corporation_id;
        window.characters[entry.character_id].alliance = entry.alliance_id;
      }
    });
}

function request_all_kills(IDs) {
  zkillCharacterLimit = 10;

  IDs = IDs.sort(affiliation_sort);
  var count = IDs.length;
  start = 0;
  end = 0;
  requestType = "characterID";
  var requests = [];

  do {
    startChar = window.characters[IDs[start]];
    endCorpIdx = start + 1;
    requestId = 0;
    length = IDs.length;
    while (
      endCorpIdx < length &&
      startChar.corp == window.characters[IDs[endCorpIdx]].corp
    )
      endCorpIdx++;

    endAllianceIdx = endCorpIdx;
    while (
      endAllianceIdx < length &&
      startChar.alliance == window.characters[IDs[endAllianceIdx]].alliance
    )
      endAllianceIdx++;

    if (endCorpIdx === start + 1) {
      requestType = "characterID";
      reqiestId = IDs[start];
      end = start + 1;
    } else if (endAllianceIdx == endCorpIdx) {
      requestType = "corporationID";
      reqiestId = startChar.corp;
      end = endCorpIdx;
    } else {
      requestType = "allianceID";
      reqiestId = startChar.alliance;
      end = endAllianceIdx;
    }

    requests.push(request_kill_batch(reqiestId, requestType, 1));
    start = end;
  } while (start < count);

  return Promise.all(requests);
}

function request_kill_batch(id, querryType, page) {
  var maxZkillKills = 200;
  url = get_url("zkill_batch", {
    querryType: querryType,
    id: id,
    startTime: window.starttime,
    endTime: window.endtime,
    page: page,
  });
  url_params = request_params.zkill_batch;

  return fetch(new Request(url, url_params))
    .then((response) => {
      if (response.status != 200)
        throw new Error("API request failed to get kills");
      return response.json();
    })
    .then((zkillData) => {
      for (var i = 0; i < zkillData.length; ++i) {
        var partialKill = window.knownKillData[zkillData[i].killmail_id];
        if (partialKill === undefined) {
          partialKill = zkillData[i];
        }
        window.partialKillData[partialKill.killmail_id] = partialKill;
      }
      console.log("Obtained " + zkillData.length + " kills from zKill");

      if (zkillData.length == maxZkillKills)
        return request_kill_batch(id, querryType, page + 1);
    });
}

function request_full_kill_data(partialKillData) {
  queries = [];
  for (var id in partialKillData) {
    if (partialKillData[id].victim !== undefined) {
      queries.push(
        new Promise(function (resolve, reject) {
          resolve(partialKillData[id]);
        })
      );
      continue;
    }

    url = get_url("esi_kill_data", {
      killmail_id: id,
      killmail_hash: partialKillData[id].zkb.hash,
    });
    url_params = request_params.esi_kill_data;

    query = fetch(new Request(url, url_params)).then((response) => {
      if (response.status != 200)
        throw new Error("API request failed to get list of character IDs");
      return response.json();
    });
    queries.push(query);
  }
  return Promise.all(queries).then((results) => {
    for (var i = 0; i < results.length; ++i) {
      r = results[i];
      kill = window.partialKillData[r.killmail_id];
      kill.attackers = r.attackers;
      kill.solar_system_id = r.solar_system_id;
      kill.victim = r.victim;
      kill.moon_id = r.moon_id;
      kill.war_id = r.war_id;
      kill.killmail_time = r.killmail_time;
      window.knownKillData[r.killmail_id] = kill;

      if (window.killIDs.indexOf(kill.killmail_id) >= 0) continue;
      if (!is_valid_kill(kill)) continue;
      kill.date = get_date(kill.killmail_time);
      var v = kill.victim;

      mark_missing_type(v.ship_type_id, false);
      mark_missing_type(v.character_id, true);

      for (var j = 0; j < kill.attackers.length; ++j) {
        var attacker = kill.attackers[j];

        if (attacker.final_blow) {
          mark_missing_type(attacker.character_id, true);
        }

        mark_missing_type(attacker.ship_type_id, false);
      }

      window.killIDs.push(kill.killmail_id);
      window.unsortedKills.push(kill);
    }
  });
}

function process_kills() {
  console.log("Processing kills...");

  window.workingKillSet = window.unsortedKills.sort(kill_sort);
  var table = document.getElementsByName("killdisplay")[0];
  table.innerHTML =
    '<div class="krh"><div class="kh">New fight?</div><div class="kh">Time</div><div class="kh">Kill/Loss</div><div class="kh">Ship</div><div class="kh">Victim</div><div class="kh">Final Blow</div><div class="kh">Location</div><div class="kh">ISK</div></div>';

  for (var i = 0; i < window.workingKillSet.length; ++i) {
    var kill = window.workingKillSet[i];
    var is_friendly = window.friendlies.has(kill.victim.character_id);
    var row = document.createElement("div");
    row.className = "kr-on";
    table.appendChild(row);
    row.name = kill.killmail_id;

    kill.display_row = row;
    kill.is_friendly = is_friendly;
    kill.is_included = true;
    kill.is_fight_start =
      i == 0 || kill.date - window.workingKillSet[i - 1].date > 5 * 60 * 1000;

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    cell.innerHTML =
      '<input type="checkbox" checked id="' + kill.killmail_id + '">';
    kill.is_fight_start_check_box = cell.children[0];
    kill.is_fight_start_check_box.checked = kill.is_fight_start;
    kill.is_fight_start_check_box.addEventListener("change", function (event) {
      var kill = get_kill_by_id(
        parseInt(event.target.id),
        window.workingKillSet
      );
      kill.is_fight_start = event.target.checked;
      update_kill_display(kill);
    });

    kill.is_fight_start_check_box.addEventListener(
      "mousedown",
      function (event) {
        event.stopPropagation();
      }
    );
    kill.is_fight_start_check_box.addEventListener(
      "touchdown",
      function (event) {
        event.stopPropagation();
      }
    );

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    cell.innerHTML =
      "<a href=https://zkillboard.com/kill/" +
      kill.killmail_id +
      '/ target="_blank">' +
      kill.killmail_time +
      "</a>";
    kill.zkill_href = cell.children[0];

    kill.zkill_href.addEventListener("mousedown", function (event) {
      event.stopPropagation();
    });
    kill.zkill_href.addEventListener("touchdown", function (event) {
      event.stopPropagation();
    });

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    t = document.createTextNode(is_friendly ? "Loss" : "Kill");
    cell.appendChild(t);

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    var shipName = window.knownTypes[kill.victim.ship_type_id];
    if (shipName === undefined) shipName = "Unknown Type";
    t = document.createTextNode(shipName);
    cell.appendChild(t);

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    var pilotName = kill.victim.character_id
      ? window.characters[kill.victim.character_id].name
      : "";
    t = document.createTextNode(pilotName);
    cell.appendChild(t);

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    var char =
      window.characters[
        kill.attackers.filter((x) => x.final_blow == 1)[0].character_id
      ];
    if (char) char = char.name;
    t = document.createTextNode(char);
    cell.appendChild(t);

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    var systemName = window.solarSystems[kill.solar_system_id];
    if (systemName === undefined) systemName = "sysId_" + kill.solar_system_id;
    t = document.createTextNode(systemName);
    cell.appendChild(t);

    var cell = document.createElement("div");
    cell.className = "kd";
    row.appendChild(cell);
    t = document.createTextNode(
      Math.round(kill.zkb.totalValue / 10000) / 100 + "m"
    );
    cell.appendChild(t);

    update_kill_display(kill);
  }

  var loader = document.getElementsByClassName("loader")[0];
  loader.style.display = "none";
  var stepTwo = document.getElementsByClassName("step-two")[0];
  stepTwo.style.display = "inherit";
}

function update_kill_display(kill) {
  kill.is_fight_start_check_box.checked = kill.is_fight_start;
  if (kill.is_fight_start) {
    kill.display_row.style.borderTop = "solid 2px #ccc";
  } else {
    kill.display_row.style.borderTop = "0px";
  }

  if (kill.is_included) {
    kill.display_row.className = "kr-on";
    kill.display_row.style.color = kill.is_friendly ? "red" : "green";
  } else {
    kill.display_row.className = "kr-off";
    kill.display_row.style.color = "#aaa";
  }
}

function get_forum_post() {
  for (var key in window.characters) {
    window.characters[key].shipsFlown = [];
  }

  for (var i = 0; i < window.workingKillSet.length; ++i) {
    var kill = window.workingKillSet[i];
    if (!kill.is_included) continue;

    var v = kill.victim;
    if (
      v.character_id !== undefined &&
      window.characters[v.character_id] !== undefined &&
      !window.characters[v.character_id].shipsFlown.includes(v.ship_type_id)
    ) {
      window.characters[v.character_id].shipsFlown.push(v.ship_type_id);
    }

    for (var j = 0; j < kill.attackers.length; ++j) {
      var attacker = kill.attackers[j];
      if (
        attacker.character_id !== undefined &&
        window.characters[attacker.character_id] !== undefined &&
        !window.characters[attacker.character_id].shipsFlown.includes(
          attacker.ship_type_id
        )
      ) {
        window.characters[attacker.character_id].shipsFlown.push(
          attacker.ship_type_id
        );
      }
    }
  }

  var sortedCharacters = Object.values(window.characters)
    .filter((x) => x.isFriendly == 1)
    .sort(char_alpha_sort);

  var templateName = document.getElementsByName("template")[0].value;
  var template = window.templates[templateName];

  var lines = [];
  lines.push(template.header());
  lines.push(template.membersHeader(window.finalNames.length));
  for (var i = 0; i < sortedCharacters.length; ++i) {
    var char = sortedCharacters[i];
    var shipList = [];
    if (char.shipsFlown.length > 0) {
      for (var j = 0; j < char.shipsFlown.length; ++j) {
        var shipName = window.knownTypes[char.shipsFlown[j]];
        if (shipName === undefined || shipName.includes("Capsule")) continue;
        shipList.push(shipName);
      }
    }
    lines.push(template.member(char.name, shipList));
  }
  lines.push(template.membersFooter());

  lines.push(template.killsHeader());

  var iskGain = 0;
  var iskLoss = 0;
  var addSeparator = true;
  for (var i = 0; i < window.workingKillSet.length; ++i) {
    var kill = window.workingKillSet[i];
    if (kill.is_fight_start) addSeparator = true;
    if (!kill.is_included) continue;

    var friendlyLine = kill.is_friendly ? "FF0000]-" : "00FF00]+";
    var shipName = window.knownTypes[kill.victim.ship_type_id];
    if (shipName === undefined) shipName = "Unknown Type";

    if (addSeparator) {
      var regions = [kill.solar_system_id];
      for (var j = i + 1; j < window.workingKillSet.length; ++j) {
        var kk = window.workingKillSet[j];
        if (kk.is_fight_start) break;
        if (kk.is_included && regions.indexOf(kk.solar_system_id) == -1) {
          regions.push(kk.solar_system_id);
        }
      }
      var regions = regions.map((x) => {
        var systemName = window.solarSystems[x];
        if (systemName === undefined) return "sysId_" + x;
        return systemName;
      });

      var time = kill.killmail_time.slice(11, 19);
      lines.push(template.killListSeparator(time, regions));

      addSeparator = false;
    }

    var zkillUrl = `https://zkillboard.com/kill/${kill.killmail_id}/`;
    var zkillValue = Math.round(kill.zkb.totalValue / 10000) / 100;
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

  var elem = document.getElementsByName("output")[0];
  elem.value = lines.join("\n");
}

var mouseDown = false;
var previousRow = undefined;
var enablingRows = false;
// function kills_mouse_down('mousedown touchstart',
function kills_mouse_down(event) {
  event.preventDefault();
  var row = event.target;
  if (row.tagName == "a" || row.tagName == "input") return;

  while (row && row.className != "kr-on" && row.className != "kr-off")
    row = row.parentElement;
  if (row) {
    kill = get_kill_by_id(parseInt(row.name), window.workingKillSet);
    enablingRows = !kill.is_included;
    mouseDown = true;
    previousRow = undefined;

    kills_update_include_state(event);
  }
}

function kills_update_include_state(event) {
  // event.preventDefault();
  if (mouseDown) {
    var row = event.target;
    while (row && row.className != "kr-on" && row.className != "kr-off")
      row = row.parentElement;
    if (row && row != previousRow) {
      kill = get_kill_by_id(parseInt(row.name), window.workingKillSet);
      kill.is_included = enablingRows;
      update_kill_display(kill);
    }
  }
}

function window_mouse_up(event) {
  mouseDown = false;
}

function window_drop(event) {
  if (event.dataTransfer.files.length == 0) return;
  if (event.dataTransfer.files[0].type != "text/plain") return;

  reader = new FileReader();
  reader.readAsText(event.dataTransfer.files[0]);
  reader.onloadend = function () {
    document.getElementsByName("names")[0].value = reader.result;
  };
}

function prevent_defaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

window.onload = function () {
  var table = document.getElementsByName("killdisplay")[0];
  console.log("loaded " + table);
  table.addEventListener("mousedown", kills_mouse_down);
  table.addEventListener("touchdown", kills_mouse_down);
  table.addEventListener("mousemove", kills_update_include_state);
  table.addEventListener("touchmove", kills_update_include_state);
  document.addEventListener("mouseup", window_mouse_up);
  document.addEventListener("touchend", window_mouse_up);
  document.addEventListener("drop", prevent_defaults, false);
  document.addEventListener("dragenter", prevent_defaults, false);
  document.addEventListener("dragover", prevent_defaults, false);
  document.addEventListener("dragleave", prevent_defaults, false);
  document.addEventListener("drop", window_drop);
};
