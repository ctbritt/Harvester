export function getByValue(map, searchValue) {
  let keyMap = "";
  for (let [key, value] of map.entries()) {
    if (value === searchValue) {
      keyMap = key;
      break;
    }
  }
  return keyMap ?? "";
}

export function checkItemSourceLabel(item, sourceLabel) {
  if (item.system.source?.label === sourceLabel) {
    return true;
  }
  if (item.system.source?.custom === sourceLabel) {
    return true;
  }
  return false;
}

export function retrieveItemSourceLabelDC(item) {
  let itemDC = undefined;
  itemDC = item.system.source?.label.match(/\d+/g)[0];
  if (!itemDC || item.system.source?.custom) {
    itemDC = item.system.source?.custom?.match(/\d+/g)[0];
  }
  return itemDC ?? 0;
}
