import { registerSettings } from "./settings.js";

var itemCompendium, harvestCompendium, harvestEffect, moduleSettings;

Hooks.on("init", function()
{
  registerSettings();
  moduleSettings = getSettings();
  console.log("harvester | Init() - Registered settings.");
});

Hooks.on("ready", async function()
{
  game.modules.get("harvester").api = {validateHarvest};
  itemCompendium = await game.packs.get("harvester.harvest-action").getDocuments();
  harvestCompendium = await game.packs.get("harvester.harvest").getDocuments();
  harvestEffect = itemCompendium[0].effects.get("0plmpCQ8D2Ezc1Do");
  console.log("harvester | ready() - Assigned public functions & Fetched compendiums");
});

// Hooks.on('renderChatMessage', function(message, html, messageData)
// {
//   if(message.flavor == "Harvest")
//     console.log(message);
// })

async function validateHarvest(controlledToken, targetedToken)
{
  if (!controlledToken && !controlledToken.isOwner)
  {
    ui.notifications.warn("Please select an owned token.");
    return;
  }
  if (game.user.targets.size != 1)
  {
    ui.notifications.warn("Please target only one token.");
    return;
  }
  if(targetedToken.document.actorData.system.attributes.hp.value != 0)
  {
    ui.notifications.warn(targetedToken.name + " is not dead");
    return;
  }
  if(!checkEffect(targetedToken, "Dead") && moduleSettings.requireDeadEffect)
  {
    ui.notifications.warn(targetedToken.name + " is not dead");
    return;
  }
  if(targetedToken.document.hasPlayerOwner && moduleSettings.npcOnlyHarvest)
  {
    ui.notifications.warn(targetedToken.name + " is not an NPC");
    return;
  }
  if(checkEffect(targetedToken, "Harvested"))
  {
    ui.notifications.warn(targetedToken.name + " has been harvested already");
    return;
  }
  await handleHarvest(targetedToken, controlledToken);
}

function checkEffect(token, effectName)
{
  var returnBool = false;
  token.document.actorData.effects.forEach(element =>
  {
    if (element.label == effectName)
      returnBool = true;
  });
  return returnBool;
}

function searchCompendium(actor)
{
  var harvestArr = [];
  harvestCompendium.forEach(doc =>
  {
    if (doc.system.source === actor.name)
      harvestArr.push(doc);
  })
  return harvestArr;
}

async function handleHarvest(targetedToken, controlledToken)
{
  var targetActor = await game.actors.get(targetedToken.document.actorId);
  var controlActor = await game.actors.get(controlledToken.document.actorId);

  var itemArr = searchCompendium(targetActor);

  var skillCheck = itemArr[0]?.system.description.unidentified.slice(0,3).toLowerCase();
  var result = await controlActor.rollSkill(skillCheck);
  if (result)
  {
    var lootMessage = "";// = "Looted from " + targetedToken.name + "<br>";
    var messageData = {content: {}, whisper: {}};
    if (moduleSettings.gmOnly)
      messageData.whisper = game.users.filter(u => u.isGM).map(u => u._id);
    var autoAdd = moduleSettings.autoAdd;

    targetedToken.toggleEffect(harvestEffect);

    itemArr.forEach(item =>
    {
      if (parseInt(item.system.description.chat) <= result.total)
      {
        //console.log(item);
        lootMessage += `<li>@UUID[${item.uuid}]</li>`
        if(autoAdd)
          controlActor.createEmbeddedDocuments('Item', [item]);
      }
    });

    if (lootMessage)
      messageData.content = `<ul>${lootMessage}</ul>`;
    else
      messageData.content = `${controlledToken.name} attempted to harvest resources from ${targetedToken.name} but failed to find anything.`
    ChatMessage.create(messageData);
  }
}