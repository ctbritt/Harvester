import { registerSettings, SETTINGS } from "./scripts/settings.js";
import { CONSTANTS } from "./scripts/constants.js";
import { RequestorHelpers } from "./scripts/requestor-helpers.js";
import API from "./scripts/api.js";
import { checkItemSourceLabel, retrieveItemSourceLabelDC } from "./scripts/lib/lib.js";
import Logger from "./scripts/lib/Logger.js";

let actionCompendium,
  harvestCompendium,
  lootCompendium,
  customCompendium,
  customLootCompendium,
  harvestBetterRollCompendium,
  harvestAction,
  lootAction,
  harvesterAndLootingSocket,
  currencyFlavors,
  hasBetterRollTables;

Hooks.on("init", function () {
  registerSettings();
  Logger.log("Init() - Registered settings & Fetched compendiums.");
});

Hooks.once("setup", function () {
  game.modules.get(CONSTANTS.MODULE_ID).api = API;
});

Hooks.on("ready", async function () {
  actionCompendium = await game.packs.get(CONSTANTS.actionCompendiumId).getDocuments();
  harvestCompendium = await game.packs.get(CONSTANTS.harvestCompendiumId).getDocuments();
  lootCompendium = await game.packs.get(CONSTANTS.lootCompendiumId).getDocuments();
  customCompendium = await game.packs.get(CONSTANTS.customCompendiumId).getDocuments();
  customLootCompendium = await game.packs.get(CONSTANTS.customLootCompendiumId).getDocuments();
  hasBetterRollTables = await game.modules.get("better-rolltables")?.active;
  if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables) {
    harvestBetterRollCompendium = await game.packs.get(CONSTANTS.betterRollTableId).getDocuments();
  }

  harvestAction = await actionCompendium.find((a) => a.id === CONSTANTS.harvestActionId);
  lootAction = await actionCompendium.find((a) => a.id === CONSTANTS.lootActionId);

  currencyFlavors = Array.from(CONSTANTS.currencyMap.keys());

  if (game.user?.isGM && !game.modules.get("socketlib")?.active)
    Logger.errorPermanent("socketlib must be installed & enabled for harvester to function correctly.", {
      permanent: true,
    });

  if (game.users.activeGM?.id !== game.user.id) {
    return;
  }
  await addActionToActors();
});

Hooks.once("socketlib.ready", () => {
  harvesterAndLootingSocket = globalThis.socketlib.registerModule(CONSTANTS.MODULE_ID);
  harvesterAndLootingSocket.register("addEffect", addEffect);
  Logger.log("Registered socketlib functions");
});

Hooks.on("createActor", async (actor, data, options, id) => {
  if (SETTINGS.autoAddActionGroup !== "None") {
    if (SETTINGS.autoAddActionGroup === "PCOnly" && actor.type === "npc") {
      return;
    }
    await addItemsToActor(actor, [harvestAction]);
    if (!SETTINGS.disableLoot) {
      await addItemsToActor(actor, [lootAction]);
    }
  }
});

Hooks.on("dnd5e.preUseItem", function (item, config, options) {
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  if (game.user.targets.size !== 1) {
    ui.notifications.warn("Please target only one token.");
    return false;
  }

  let targetedToken = game.user.targets.first();
  let controlToken = item.parent.getActiveTokens()[0];

  if (!validateAction(controlToken, targetedToken, item.name)) {
    return false;
  }
  item.setFlag(CONSTANTS.MODULE_ID, "targetId", targetedToken.id);
  item.setFlag(CONSTANTS.MODULE_ID, "controlId", controlToken.id);
});

Hooks.on("dnd5e.useItem", function (item, config, options) {
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  if (item.name === harvestAction.name) {
    handlePreRollHarvestAction({ item: item });
  }
  if (item.name === lootAction.name && !SETTINGS.disableLoot) {
    handlePreRollLootAction({ item: item });
  }
});

export async function handlePreRollHarvestAction(options) {
  const { item } = options;
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  let targetedToken =
    canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.targetId`)) ?? game.user.targets.first();
  let targetedActor = await game.actors.get(targetedToken.document.actorId);
  let controlledToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.controlId`));

  let matchedItems = [];
  if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables) {
    matchedItems = retrieveTablesHarvestWithBetterRollTables(targetedActor, harvestAction.name || item.name);
  } else {
    matchedItems = searchCompendium(targetedActor, harvestAction.name || item.name);
  }
  /*
  if (item.name === lootAction.name) {
    if (matchedItems.length === 0) {
      RequestorHelpers.requestRollSkill(
        controlledToken.actor,
        undefined,
        {
          chatTitle: "Scavenge valuables from corpses.",
          chatDescription: `After examining the corpse you realise there is nothing you can loot.`,
          chatButtonLabel: undefined,
          chatWhisper: undefined,
          chatSpeaker: undefined,
        },
        {
          skillDenomination: getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`),
          skillItem: item,
          skillCallback: "handlePostRollHarvestAction",
          skillChooseModifier: SETTINGS.allowAbilityChange,
        }
      );
    } else {
      RequestorHelpers.requestRollSkill(
        controlledToken.actor,
        undefined,
        {
          chatTitle: "Scavenge valuables from corpses.",
          chatDescription: `Looting ${targetedToken.name}`,
          chatButtonLabel: undefined,
          chatWhisper: undefined,
          chatSpeaker: undefined,
        },
        {
          skillDenomination: getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`),
          skillItem: item,
          skillCallback: "handlePostRollHarvestAction",
          skillChooseModifier: SETTINGS.allowAbilityChange,
        }
      );
    }

    return;
  }
  */
  if (matchedItems.length !== 0) {
    let skillCheckVerbose;
    let skillCheck = "Nature"; // TODO
    let harvestMessage = targetedToken.name;
    if (harvestMessage !== targetedActor.name) {
      harvestMessage += ` (${targetedActor.name})`;
    }
    if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables) {
      skillCheckVerbose = getProperty(matchedItems[0], `flags.better-rolltables.brt-skill-value`);
      skillCheck = skillCheckVerbose;
    } else {
      if (matchedItems[0].compendium.metadata.id === CONSTANTS.harvestCompendiumId) {
        skillCheckVerbose = matchedItems[0]?.system.description.unidentified;
      } else {
        skillCheckVerbose = matchedItems[0].items.find((element) => element.type === "feat").name;
      }
      skillCheck = CONSTANTS.skillMap.get(skillCheckVerbose);
    }

    item.setFlag(CONSTANTS.MODULE_ID, "skillCheck", skillCheck);
    item.update({ system: { formula: `1d20 + @skills.${skillCheck}.total` } });

    RequestorHelpers.requestRollSkill(
      controlledToken.actor,
      undefined,
      {
        chatTitle: `Harvesting Skill Check (${getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`)})`,
        chatDescription: "Harvest valuable materials from corpses.",
        chatButtonLabel: `Attempting to Harvest ${harvestMessage}`,
        chatWhisper: undefined,
        chatSpeaker: undefined,
        chatImg: "icons/tools/cooking/knife-cleaver-steel-grey.webp",
      },
      {
        skillDenomination: getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`),
        skillItem: item,
        skillCallback: "handlePostRollHarvestAction",
        skillChooseModifier: SETTINGS.allowAbilityChange,
      }
    );
  } else {
    item.update({ system: { formula: "" } });
    item.setFlag(CONSTANTS.MODULE_ID, "targetId", "");

    RequestorHelpers.requestRollSkill(
      controlledToken.actor,
      undefined,
      {
        chatTitle: `Harvesting Skill Check (${getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`)})`,
        chatDescription: `After examining the corpse you realise there is nothing you can harvest.`,
        chatButtonLabel: undefined,
        chatWhisper: undefined,
        chatSpeaker: undefined,
        chatImg: "icons/tools/cooking/knife-cleaver-steel-grey.webp",
      },
      {
        skillDenomination: getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`),
        skillItem: item,
        skillCallback: "handlePostRollHarvestAction",
        skillChooseModifier: SETTINGS.allowAbilityChange,
      }
    );

    harvesterAndLootingSocket.executeAsGM(addEffect, targetedToken.id, "Harvest");
  }
}

export async function handlePostRollHarvestAction(options) {
  const { actor, item, roll } = options;
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  let targetedToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.targetId`));
  let targetedActor = await game.actors.get(targetedToken.document.actorId);
  let controlledToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.controlId`));

  if (!validateAction(controlledToken, targetedToken, item.name)) {
    return false;
  }

  let result = roll;
  let harvesterMessage = "";
  let successArr = [];
  let messageData = { content: "", whisper: {} };
  if (SETTINGS.gmOnly) {
    messageData.whisper = game.users.filter((u) => u.isGM).map((u) => u._id);
  }

  let matchedItems = [];
  harvesterAndLootingSocket.executeAsGM(addEffect, targetedToken.id, "Harvest");

  if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables && item.name === harvestAction.name) {
    matchedItems = await retrieveItemsHarvestWithBetterRollTables(
      targetedActor,
      item.name,
      result.total,
      getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`)
    );

    matchedItems.forEach((item) => {
      if (item.type === "loot") {
        harvesterMessage += `<li>@UUID[${item.uuid}]</li>`;
        successArr.push(item);
      }
    });
  } else {
    matchedItems = await searchCompendium(targetedActor, item.name);

    if (matchedItems[0].compendium.metadata.id === CONSTANTS.customCompendiumId) {
      matchedItems = matchedItems[0].items;
    }
    matchedItems.forEach((item) => {
      if (item.type === "loot") {
        let itemDC = 0;
        if (item.compendium.metadata.id === CONSTANTS.harvestCompendiumId) {
          itemDC = parseInt(item.system.description.chat);
        } else {
          itemDC = retrieveItemSourceLabelDC(item); //item.system.source.label.match(/\d+/g)[0];
        }
        if (itemDC <= result.total) {
          harvesterMessage += `<li>@UUID[${item.uuid}]</li>`;
          successArr.push(item.toObject());
        }
      }
    });
  }

  if (SETTINGS.autoAddItems && successArr?.length > 0) {
    if (SETTINGS.autoAddItemPiles && game.modules.get("item-piles")?.active) {
      await addItemsToActorWithItemPiles(controlledToken.actor, successArr);
    } else {
      await addItemsToActor(controlledToken.actor, successArr);
    }
  } else {
    harvesterMessage = `After examining the corpse you realise there is nothing you can harvest.`;
  }

  if (harvesterMessage) {
    messageData.content = `<h3>Harvesting</h3><ul>${harvesterMessage}</ul>`;
  }

  ChatMessage.create(messageData);

  return false;
}

export async function handlePostRollLootAction(options) {
  const { actor, item, roll } = options;
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  let targetedToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.targetId`));
  let targetedActor = await game.actors.get(targetedToken.document.actorId);
  let controlledToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.controlId`));

  if (!validateAction(controlledToken, targetedToken, item.name)) {
    return false;
  }

  let result = roll;
  let harvesterMessage = "";
  let successArr = [];
  let messageData = { content: "", whisper: {} };
  if (SETTINGS.gmOnly) {
    messageData.whisper = game.users.filter((u) => u.isGM).map((u) => u._id);
  }

  let matchedItems = [];
  harvesterAndLootingSocket.executeAsGM(addEffect, targetedToken.id, "Harvest");

  if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables && item.name === harvestAction.name) {
    matchedItems = await retrieveItemsHarvestWithBetterRollTables(
      targetedActor,
      item.name,
      result.total,
      getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`)
    );

    matchedItems.forEach((item) => {
      if (item.type === "loot") {
        harvesterMessage += `<li>@UUID[${item.uuid}]</li>`;
        successArr.push(item);
      }
    });
  } else {
    matchedItems = await searchCompendium(targetedActor, item.name);

    if (matchedItems[0].compendium.metadata.id === CONSTANTS.customCompendiumId) {
      matchedItems = matchedItems[0].items;
    }
    matchedItems.forEach((item) => {
      if (item.type === "loot") {
        let itemDC = 0;
        if (item.compendium.metadata.id === CONSTANTS.harvestCompendiumId) {
          itemDC = parseInt(item.system.description.chat);
        } else {
          itemDC = retrieveItemSourceLabelDC(item); //item.system.source.label.match(/\d+/g)[0];
        }
        if (itemDC <= result.total) {
          harvesterMessage += `<li>@UUID[${item.uuid}]</li>`;
          successArr.push(item.toObject());
        }
      }
    });
  }

  if (SETTINGS.autoAddItems && successArr?.length > 0) {
    if (SETTINGS.autoAddItemPiles && game.modules.get("item-piles")?.active) {
      await addItemsToActorWithItemPiles(controlledToken.actor, successArr);
    } else {
      await addItemsToActor(controlledToken.actor, successArr);
    }
  } else {
    harvesterMessage = `After examining the corpse you realise there is nothing you can harvest.`;
  }

  if (harvesterMessage) {
    messageData.content = `<h3>Harvesting</h3><ul>${harvesterMessage}</ul>`;
  }

  ChatMessage.create(messageData);

  return false;
}

function validateAction(controlToken, targetedToken, actionName) {
  let measuredDistance = canvas.grid.measureDistance(controlToken.center, targetedToken.center);
  let targetSize = CONSTANTS.sizeHashMap.get(targetedToken.actor.system.traits.size);
  if (measuredDistance > targetSize && SETTINGS.enforceRange) {
    ui.notifications.warn("You must be in range to " + actionName);
    return false;
  }

  let actor = null;
  if (!isEmptyObject(targetedToken.document.delta?.system)) actor = targetedToken.document.delta;
  else if (!isEmptyObject(targetedToken.document.actor)) actor = targetedToken.document.actor;
  else if (targetedToken.document.actorId) actor = game.actors.get(targetedToken.document.actorId);

  if (!actor) {
    ui.notifications.warn(targetedToken.name + " has not data to retrieve");
    return false;
  }
  if (actor.system.attributes.hp.value !== 0) {
    ui.notifications.warn(targetedToken.name + " is not dead");
    return false;
  }
  if (!checkEffect(targetedToken, "Dead") && SETTINGS.requireDeadEffect) {
    ui.notifications.warn(targetedToken.name + " is not dead");
    return false;
  }
  if (targetedToken.document.hasPlayerOwner && SETTINGS.npcOnlyHarvest) {
    ui.notifications.warn(targetedToken.name + " is not an NPC");
    return false;
  }
  if (checkEffect(targetedToken, `${actionName}ed`)) {
    ui.notifications.warn(`${targetedToken.name} has been ${actionName.toLowerCase()}ed already`);
    return false;
  }
  return true;
}

function handlePreRollLootAction(options) {
  const { item } = options;
  if (!checkItemSourceLabel(item, "Harvester")) {
    return;
  }
  let targetedToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.targetId`));
  let targetedActor = game.actors.get(targetedToken.document.actorId);
  let controlledToken = canvas.tokens.get(getProperty(item, `flags.${CONSTANTS.MODULE_ID}.controlId`));
  let controlActor = game.actors.get(controlledToken.document.actorId);

  let matchedItems = [];
  if (SETTINGS.enableBetterRollIntegration && hasBetterRollTables) {
    // TODO
    //matchedItems = retrieveTablesHarvestWithBetterRollTables(targetedActor, item.name);
    matchedItems = searchCompendium(targetedActor, lootAction.name);
  } else {
    matchedItems = searchCompendium(targetedActor, lootAction.name);
  }

  if (matchedItems.length === 0) {
    RequestorHelpers.requestEmptyMessage(controlledToken.actor, undefined, {
      chatTitle: "Looting valuable from corpses.",
      chatDescription: `<h3>Looting</h3><ul>${controlledToken.name} attempted to loot resources from ${targetedToken.name} but failed to find anything.`,
      chatButtonLabel: undefined,
      chatWhisper: undefined,
      chatSpeaker: undefined,
      chatImg: "icons/skills/social/theft-pickpocket-bribery-brown.webp",
    });
  } else {
    RequestorHelpers.requestRollSkill(
      controlledToken.actor,
      undefined,
      {
        chatTitle: "Looting valuable from corpses.",
        chatDescription: `Looting ${targetedToken.name}`,
        chatButtonLabel: undefined,
        chatWhisper: undefined,
        chatSpeaker: undefined,
        chatImg: "icons/skills/social/theft-pickpocket-bribery-brown.webp",
      },
      {
        skillDenomination: getProperty(item, `flags.${CONSTANTS.MODULE_ID}.skillCheck`),
        skillItem: item,
        skillCallback: "handlePostRollHarvestAction",
        skillChooseModifier: SETTINGS.allowAbilityChange,
      }
    );
  }

  harvesterAndLootingSocket.executeAsGM(addEffect, targetedToken.id, lootAction.name);

  if (matchedItems.length === 0) {
    item.setFlag(CONSTANTS.MODULE_ID, "targetId", "");
    return;
  }

  let normalLoot = matchedItems[0].description;
  if (normalLoot === "false" && !SETTINGS.lootBeasts) {
    ChatMessage.create(messageData);
    return;
  }

  matchedItems[0].description = ""; //remove the boolean present in the description which describes if the entry is a beast that doesn't normally have loot

  matchedItems[0].roll({ async: false }).then((result) => {
    let rollMap = formatLootRoll(result.results[0].text);
    let lootMessage = "";

    currencyFlavors.forEach((currency) => {
      if (!rollMap.has(currency)) return;

      let roll = new Roll(rollMap.get(currency));
      let rollResult = roll.roll({ async: false });
      lootMessage += `<li>${rollResult.total} ${currency}</li>`;
      if (SETTINGS.autoAddItems) {
        updateActorCurrency(controlActor, currency, rollResult.total);
      }
    });

    messageData.content = `<h3>Looting</h3>After examining the corpse you find:<ul>${lootMessage}</ul>`;

    ChatMessage.create(messageData);
    return;
  });
}

function formatLootRoll(result) {
  let rollTableResult = result.replace(/(\[\[\/r\s)?(\]\])?(\}$)?/g, "").split("}");
  let returnMap = new Map();

  for (let i = 0; i < rollTableResult.length; i++) {
    let extractedRoll = rollTableResult[i].split("{");
    returnMap.set(extractedRoll[1], extractedRoll[0]);
  }
  return returnMap;
}

function updateActorCurrency(actor, currencyLabel, toAdd) {
  let currencyRef = CONSTANTS.currencyMap.get(currencyLabel);
  let total = actor.system.currency[currencyRef] + toAdd;
  actor.update({
    system: {
      currency: {
        [currencyRef]: total,
      },
    },
  });
  Logger.log(`Added ${toAdd} ${currencyLabel} to: ${actor.name}`);
}

function searchCompendium(actor, actionName) {
  let returnArr = [];
  let actorName = actor.name;
  if (actorName.includes("Dragon")) {
    actorName = formatDragon(actorName);
  }
  if (actionName === harvestAction.name) {
    returnArr = checkCompendium(customCompendium, "name", actor.name);

    if (returnArr.length !== 0) return returnArr;

    returnArr = checkCompendium(harvestCompendium, "system.source.label", actorName);
  } else if (actionName === lootAction.name && !SETTINGS.disableLoot) {
    returnArr = checkCompendium(customLootCompendium, "name", actor.name);

    if (returnArr.length !== 0) {
      return returnArr;
    }
    returnArr = checkCompendium(lootCompendium, "name", actorName);
  }

  return returnArr;
}

function checkCompendium(compendium, checkProperty, matchProperty) {
  let returnArr = [];
  compendium.forEach((doc) => {
    if (eval(`doc.${checkProperty}`) === matchProperty) {
      returnArr.push(doc);
    }
  });
  return returnArr;
}

function retrieveTablesHarvestWithBetterRollTables(targetedActor, actionName) {
  let actorName = targetedActor.name;
  if (actorName.includes("Dragon")) {
    actorName = formatDragon(actorName);
  }
  if (actionName === harvestAction.name) {
    // const dcValue = getProperty(xxx, `system.description.chat`);
    // const skillValue = getProperty(xxx, `system.description.unidentified`);
    const sourceValue = actorName ?? ""; // getProperty(xxx, `system.source`);
    // let compendium = game.packs.get(betterRollTableId);
    // const docs = compendium.contents;
    const docs = harvestBetterRollCompendium;
    let tablesChecked = [];
    // Try with the compendium first
    for (const doc of docs) {
      if (sourceValue.trim() === getProperty(doc, `flags.better-rolltables.brt-source-value`)?.trim()) {
        tablesChecked.push(doc);
      }
    }
    // Try on the tables imported
    if (!tablesChecked || tablesChecked.length === 0) {
      tablesChecked = game.tables.contents.filter((doc) => {
        return sourceValue.trim() === getProperty(doc, `flags.better-rolltables.brt-source-value`)?.trim();
      });
    }
    // We juts get the first
    if (!tablesChecked || tablesChecked.length === 0) {
      ui.notifications.warn(`No rolltable found for metadata sourceId '${sourceValue}'`);
      return [];
    }
    return tablesChecked;
  } else {
    return [];
  }
}

async function retrieveItemsHarvestWithBetterRollTables(targetedActor, actionName, dcValue = null, skillDenom = null) {
  let returnArr = [];
  if (actionName === harvestAction.name) {
    if (!dcValue) {
      dcValue = 0;
    }
    if (!skillDenom) {
      skillDenom = "";
    }

    const tablesChecked = retrieveTablesHarvestWithBetterRollTables(targetedActor, actionName);
    if (!tablesChecked || tablesChecked.length === 0) {
      return [];
    }
    const tableHarvester = tablesChecked[0];
    returnArr = await game.modules.get("better-rolltables").api.retrieveItemsDataFromRollTableResultSpecialHarvester({
      table: tableHarvester,
      options: {
        rollMode: "gmroll",
        dc: dcValue,
        skill: skillDenom,
      },
    });
  } else if (actionName === lootAction.name && !SETTINGS.disableLoot) {
    // TODO A INTEGRATION WITH THE LOOT TYPE TABLE
    returnArr = checkCompendium(customLootCompendium, "name", actor.name);

    if (returnArr.length !== 0) {
      return returnArr;
    }

    returnArr = checkCompendium(lootCompendium, "name", actorName);
  }

  return returnArr ?? [];
}

async function addActionToActors() {
  if (SETTINGS.autoAddActionGroup === "None") {
    return;
  }
  game.actors.forEach(async (actor) => {
    if (SETTINGS.autoAddActionGroup === "PCOnly" && actor.type === "npc") {
      return;
    }
    let hasHarvest = false;
    let hasLoot = false;

    actor.items.forEach((item) => {
      if (item.name === harvestAction.name && checkItemSourceLabel(item, "Harvester")) {
        hasHarvest = true;
        resetToDefault(item);
      }
      if (item.name === lootAction.name && checkItemSourceLabel(item, "Harvester")) {
        hasLoot = true;
        resetToDefault(item);
        if (SETTINGS.disableLoot) {
          actor.deleteEmbeddedDocuments("Item", [item.id]);
        }
      }
    });

    if (!hasHarvest) {
      await addItemsToActor(actor, [harvestAction]);
    }
    if (!hasLoot && !SETTINGS.disableLoot) {
      await addItemsToActor(actor, [lootAction]);
    }
  });
  Logger.log("harvester | ready() - Added Actions to All Actors specified in Settings");
}

function checkEffect(token, effectName) {
  let returnBool = false;
  token.document.delta?.effects?.forEach((element) => {
    if (element.name === effectName) returnBool = true;
  });
  return returnBool;
}

function formatDragon(actorName) {
  let actorSplit = actorName.split(" ");
  CONSTANTS.dragonIgnoreArr.forEach((element) => {
    actorSplit = actorSplit.filter((e) => e !== element);
  });

  actorSplit = actorSplit.join(" ");
  return actorSplit;
}

function resetToDefault(item) {
  let actionDescription = `Harvest valuable materials from corpses.`;
  if (item.name === lootAction.name) actionDescription = `Scavenge valuables from corpses.`;
  item.update({
    flags: { harvester: { targetId: "", controlId: "" } },
    system: { formula: "", description: { value: actionDescription } },
  });
}

function addEffect(targetTokenId, actionName) {
  let targetToken = canvas.tokens.get(targetTokenId);
  if (actionName === harvestAction.name) {
    targetToken.document.toggleActiveEffect(
      {
        id: CONSTANTS.harvestActionEffectId,
        icon: CONSTANTS.harvestActionEffectIcon,
        label: CONSTANTS.harvestActionEffectName,
      },
      { active: true }
    );
  } else if (actionName === lootAction.name && !SETTINGS.disableLoot) {
    targetToken.document.toggleActiveEffect(
      { id: CONSTANTS.lootActionEffectId, icon: CONSTANTS.lootActionEffectIcon, label: CONSTANTS.lootActionEffectName },
      { active: true }
    );
  }
  Logger.log(`Added ${actionName.toLowerCase()}ed effect to: ${targetToken.name}`);
}

async function addItemsToActor(actor, itemsToAdd) {
  for (const item of itemsToAdd) {
    await _createItem(item, actor);
  }
}
async function addItemsToActorWithItemPiles(targetedToken, itemsToAdd) {
  game.itempiles.API.addItems(targetedToken, itemsToAdd, {
    mergeSimilarItems: true,
  });
  Logger.log(`Added ${itemsToAdd.length} items to ${targetedToken.name}`);
}

function isEmptyObject(obj) {
  // because Object.keys(new Date()).length === 0;
  // we have to do some additional check
  if (obj === null || obj === undefined) {
    return true;
  }
  if (isRealNumber(obj)) {
    return false;
  }
  const result =
    obj && // null and undefined check
    Object.keys(obj).length === 0; // || Object.getPrototypeOf(obj) === Object.prototype);
  return result;
}

function isRealNumber(inNumber) {
  return !isNaN(inNumber) && typeof inNumber === "number" && isFinite(inNumber);
}

/**
 *
 * @param {Item}  item The item to add to the actor
 * @param {Actor} actor to which to add items to
 * @param {boolean} stackSame if true add quantity to an existing item of same name in the current actor
 * @param {number} customLimit
 * @returns {Item} the create/updated Item
 */
async function _createItem(item, actor, stackSame = true, customLimit = 0) {
  const QUANTITY_PROPERTY_PATH = "system.quantity";
  const WEIGHT_PROPERTY_PATH = "system.weight";
  const PRICE_PROPERTY_PATH = "system.price";

  const newItemData = item;
  const itemPrice = getProperty(newItemData, PRICE_PROPERTY_PATH) || 0;
  const embeddedItems = [...actor.getEmbeddedCollection("Item").values()];
  // Name should be enough for a check for the same item right ?
  const originalItem = embeddedItems.find((i) => i.name === newItemData.name);

  /** if the item is already owned by the actor (same name and same PRICE) */
  if (originalItem && stackSame) {
    /** add quantity to existing item */

    const stackAttribute = QUANTITY_PROPERTY_PATH;
    const priceAttribute = PRICE_PROPERTY_PATH;
    const weightAttribute = WEIGHT_PROPERTY_PATH;

    const newItemQty = getProperty(newItemData, stackAttribute) || 1;
    const originalQty = getProperty(originalItem, stackAttribute) || 1;
    const updateItem = { _id: originalItem.id };
    const newQty = Number(originalQty) + Number(newItemQty);
    if (customLimit > 0) {
      // limit is bigger or equal to newQty
      if (Number(customLimit) < Number(newQty)) {
        //limit was reached, we stick to that limit
        ui.notifications.warn("Custom limit is been reached for the item '" + item.name + "'");
        return customLimit;
      }
    }
    // If quantity differ updated the item
    if (newQty !== newItemQty) {
      setProperty(updateItem, stackAttribute, newQty);

      const newPriceValue =
        (getProperty(originalItem, priceAttribute)?.value ?? 0) +
        (getProperty(newItemData, priceAttribute)?.value ?? 0);
      const newPrice = {
        denomination: getProperty(item, priceAttribute)?.denomination,
        value: newPriceValue,
      };
      setProperty(updateItem, `${priceAttribute}`, newPrice);

      const newWeight =
        (getProperty(originalItem, weightAttribute) ?? 1) + (getProperty(newItemData, weightAttribute) ?? 1);
      setProperty(updateItem, `${weightAttribute}`, newWeight);

      await actor.updateEmbeddedDocuments("Item", [updateItem]);
      Logger.log(`Updated ${item.name} to ${actor.name}`);
    } else {
      Logger.log(`Nothing is done with ${item.name} on ${actor.name}`);
    }
  } else {
    /** we create a new item if we don't own already */
    await actor.createEmbeddedDocuments("Item", [newItemData]);
    Logger.log(`Added ${item.name} to ${actor.name}`);
  }
}
