// Hiyori extracted helpers — MIT; original sources are in src/hiyori/.
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/hiyori/materialFamilies.ts
function minecraftMaterialFamily(name) {
  const normalized = String(name ?? "").toLowerCase();
  if (normalized === "planks" || normalized.endsWith("_planks")) return "planks";
  if (normalized === "log" || normalized === "log2" || normalized.endsWith("_log") || normalized.endsWith("_wood") || normalized.endsWith("_stem") || normalized.endsWith("_hyphae")) {
    return "logs";
  }
  return void 0;
}
function canonicalMinecraftMaterial(name) {
  const family = minecraftMaterialFamily(name);
  if (family === "planks") return "planks";
  if (family === "logs") return "log";
  return name;
}

// src/hiyori/craftPlanner.ts
var MAX_EXPANDED_BRANCHES = 4096;
var WORLD_RESOURCES = /* @__PURE__ */ new Set([
  "coal",
  "diamond",
  "redstone",
  "lapis_lazuli",
  "raw_iron",
  "raw_copper",
  "raw_gold",
  "cobblestone",
  "cobbled_deepslate",
  "blackstone",
  "dirt",
  "sand",
  "gravel",
  "clay_ball"
]);
var SMELT_ITEMS_PER_FUEL = 8;
var SMELT_FUEL_ITEM = "coal";
var KNOWN_SMELT_INPUTS = {
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  glass: ["sand"],
  stone: ["cobblestone"],
  cooked_porkchop: ["porkchop"],
  cooked_beef: ["beef"],
  cooked_chicken: ["chicken"],
  cooked_mutton: ["mutton"],
  cooked_rabbit: ["rabbit"],
  cooked_cod: ["cod"],
  cooked_salmon: ["salmon"],
  cooked_fish: ["fish"],
  baked_potato: ["potato"],
  dried_kelp: ["kelp"]
};
function planCraft(bot, itemName, amount, resourcePreferences = {}) {
  const registry = bot.registry;
  const itemsByName = registry?.itemsByName ?? {};
  const targetItem = normalizeItemName(itemName, itemsByName);
  const targetAmount = Math.max(1, Math.trunc(amount));
  const itemId = itemsByName[targetItem]?.id;
  const emptyPlan = createEmptyPlan(targetItem, targetAmount);
  if (itemId === void 0) return emptyPlan;
  const stock = inventoryCounts(bot);
  const nameById = itemNamesById(itemsByName);
  const context = {
    registry,
    recipesSource: recipesSourceFor(bot),
    nameById,
    candidateCache: /* @__PURE__ */ new Map(),
    expandedBranches: 0,
    resourcePreferences
  };
  if (recipeCandidates(context, itemId).length === 0) return emptyPlan;
  const initial = {
    stock,
    initialStockRemaining: { ...stock },
    initialStockUsed: 0,
    demand: { [targetItem]: targetAmount },
    steps: [],
    totalRequired: {},
    missing: {},
    sources: {},
    requiresCraftingTable: false,
    operationCount: 0,
    preferenceCost: 0
  };
  const requiredTargetStock = (stock[targetItem] ?? 0) + targetAmount;
  const planned = ensureStock(targetItem, requiredTargetStock, initial, /* @__PURE__ */ new Set(), context);
  if (!planned) {
    return {
      ...emptyPlan,
      recipeAvailable: true,
      missing: { [targetItem]: targetAmount },
      sources: { [targetItem]: sourceHint(registry, targetItem, itemId) }
    };
  }
  const normalizedMissing = normalizeGatherableShortages(planned.missing);
  return {
    targetItem,
    targetAmount,
    steps: orderStepsDependencyFirst(planned.steps),
    totalRequired: planned.totalRequired,
    missing: normalizedMissing,
    sources: normalizeShortageSources(planned.sources, normalizedMissing),
    requiresCraftingTable: planned.requiresCraftingTable,
    canCraftNow: Object.keys(normalizedMissing).length === 0,
    recipeAvailable: true
  };
}
function ensureStock(itemName, requiredStock, state, path, context) {
  const have = availableStock(state.stock, itemName);
  if (have >= requiredStock) return state;
  if (path.has(itemName)) return null;
  const shortage = requiredStock - have;
  const itemId = context.registry?.itemsByName?.[itemName]?.id;
  let candidates = itemId === void 0 ? [] : recipeCandidates(context, itemId);
  if (WORLD_RESOURCES.has(itemName) || /^(?:log2?)$|_ore$/.test(itemName) || /_log$|_stem$/.test(itemName) && !itemName.startsWith("stripped_")) {
    candidates = candidates.filter((candidate) => {
      const ingredients = scaledCandidateIngredients(candidate, Math.ceil(shortage / candidate.outputPerCraft), context.nameById);
      return ingredients && Object.entries(ingredients).every(([name, count]) => availableStock(state.stock, name) >= count);
    });
  }
  if (candidates.length === 0) {
    const raw = clonePlanningState(state);
    raw.missing[itemName] = (raw.missing[itemName] ?? 0) + shortage;
    raw.sources[itemName] = sourceHint(context.registry, itemName, itemId);
    raw.stock[itemName] = (raw.stock[itemName] ?? 0) + shortage;
    return raw;
  }
  const childPath = new Set(path);
  childPath.add(itemName);
  let best = null;
  for (const candidate of candidates) {
    context.expandedBranches += 1;
    if (context.expandedBranches > MAX_EXPANDED_BRANCHES) break;
    const craftCount = Math.ceil(shortage / candidate.outputPerCraft);
    const ingredients = scaledCandidateIngredients(candidate, craftCount, context.nameById);
    if (!ingredients) continue;
    let branch = clonePlanningState(state);
    const ingredientEntries = Object.entries(ingredients).sort(([left], [right]) => left.localeCompare(right));
    for (const [ingredient, count] of ingredientEntries) {
      if (!branch) break;
      branch.demand[ingredient] = (branch.demand[ingredient] ?? 0) + count;
      branch.totalRequired[ingredient] = (branch.totalRequired[ingredient] ?? 0) + count;
      branch = ensureStock(ingredient, count, branch, childPath, context);
      if (!branch) break;
      consumeIngredientStock(branch, ingredient, count);
    }
    if (!branch) continue;
    branch.stock[itemName] = (branch.stock[itemName] ?? 0) + craftCount * candidate.outputPerCraft;
    branch.operationCount += craftCount;
    branch.preferenceCost += candidate.preference;
    branch.requiresCraftingTable ||= candidate.requiresTable;
    mergePlanStep(branch, {
      item: itemName,
      amount: branch.demand[itemName] ?? shortage,
      kind: candidate.kind,
      ingredients,
      requiresCraftingTable: candidate.requiresTable,
      outputPerCraft: candidate.outputPerCraft,
      craftCount,
      recipeSignature: candidate.signature
    });
    if (!best || comparePlanningStates(branch, best) < 0) best = branch;
  }
  return best;
}
function recipeCandidates(context, itemId) {
  const cached = context.candidateCache.get(itemId);
  if (cached) return cached;
  const unique = /* @__PURE__ */ new Map();
  const recipes = context.recipesSource?.[itemId];
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    if (isFurnaceRecipe(context.recipesSource, recipe)) continue;
    const entries = parseRecipeEntries(recipe).filter((entry) => entry !== null && entry !== void 0);
    const ingredients = {};
    let valid = true;
    for (const ingredientId of entries) {
      const name = context.nameById.get(ingredientId);
      if (!name) {
        valid = false;
        break;
      }
      ingredients[name] = (ingredients[name] ?? 0) + 1;
    }
    if (!valid || Object.keys(ingredients).length === 0) continue;
    const outputPerCraft = Math.max(1, recipe.result?.count ?? 1);
    const requiresTable = recipeRequiresCraftingTable(recipe);
    const signature = candidateSignature("craft", ingredients, outputPerCraft, requiresTable);
    unique.set(signature, {
      kind: "craft",
      ingredients,
      outputPerCraft,
      requiresTable,
      preference: Object.entries(ingredients).reduce((sum, [name, count]) => sum + (context.resourcePreferences[name] ?? 0) * count, 0),
      signature
    });
  }
  const smeltInputIds = smeltInputsFor(context.registry, itemId, context.recipesSource);
  for (const [preference, smeltInputId] of smeltInputIds.entries()) {
    const smeltInputName = context.nameById.get(smeltInputId);
    if (!smeltInputName) continue;
    const ingredients = { [smeltInputName]: 1 };
    const signature = candidateSignature("smelt", ingredients, 1, false);
    unique.set(signature, {
      kind: "smelt",
      ingredients,
      outputPerCraft: 1,
      requiresTable: false,
      smeltInputId,
      preference: preference + (context.resourcePreferences[smeltInputName] ?? 0),
      signature
    });
  }
  const candidates = [...unique.values()].sort((left, right) => left.preference - right.preference || left.signature.localeCompare(right.signature));
  context.candidateCache.set(itemId, candidates);
  return candidates;
}
function scaledCandidateIngredients(candidate, craftCount, nameById) {
  if (candidate.kind === "craft") return scaleIngredients(candidate.ingredients, craftCount);
  const inputName = candidate.smeltInputId === void 0 ? void 0 : nameById.get(candidate.smeltInputId);
  if (!inputName) return null;
  return {
    [inputName]: craftCount,
    [SMELT_FUEL_ITEM]: Math.ceil(craftCount / SMELT_ITEMS_PER_FUEL)
  };
}
function mergePlanStep(state, incoming) {
  const existing = state.steps.find((step) => step.item === incoming.item && step.recipeSignature === incoming.recipeSignature);
  if (!existing) {
    state.steps.push(incoming);
    return;
  }
  existing.amount = Math.max(existing.amount, state.demand[incoming.item] ?? incoming.amount);
  existing.craftCount = (existing.craftCount ?? 0) + (incoming.craftCount ?? 0);
  for (const [name, count] of Object.entries(incoming.ingredients)) {
    existing.ingredients[name] = (existing.ingredients[name] ?? 0) + count;
  }
}
function comparePlanningStates(left, right) {
  const leftRank = planningRank(left);
  const rightRank = planningRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index] - rightRank[index];
    if (difference !== 0) return difference;
  }
  return planSignature(left).localeCompare(planSignature(right));
}
function planningRank(state) {
  return [
    Object.keys(state.missing).length,
    Object.values(state.missing).reduce((sum, count) => sum + count, 0),
    state.operationCount,
    state.initialStockUsed,
    state.preferenceCost,
    state.requiresCraftingTable ? 1 : 0
  ];
}
function planSignature(state) {
  return state.steps.map((step) => `${step.item}:${step.recipeSignature ?? ""}:${step.craftCount ?? 0}`).sort().join("|");
}
function candidateSignature(kind, ingredients, outputPerCraft, requiresTable) {
  const ingredientText = Object.entries(ingredients).sort(([left], [right]) => left.localeCompare(right)).map(([name, count]) => `${name}=${count}`).join(",");
  return `${kind}|${ingredientText}|out=${outputPerCraft}|table=${requiresTable ? 1 : 0}`;
}
function clonePlanningState(state) {
  return {
    stock: { ...state.stock },
    initialStockRemaining: { ...state.initialStockRemaining },
    initialStockUsed: state.initialStockUsed,
    demand: { ...state.demand },
    steps: state.steps.map((step) => ({ ...step, ingredients: { ...step.ingredients } })),
    totalRequired: { ...state.totalRequired },
    missing: { ...state.missing },
    sources: { ...state.sources },
    requiresCraftingTable: state.requiresCraftingTable,
    operationCount: state.operationCount,
    preferenceCost: state.preferenceCost
  };
}
function normalizeGatherableShortages(missing) {
  const normalized = {};
  for (const [name, count] of Object.entries(missing)) {
    const key = canonicalMinecraftMaterial(name);
    normalized[key] = (normalized[key] ?? 0) + count;
  }
  return normalized;
}
function normalizeShortageSources(sources, missing) {
  const normalized = {};
  for (const name of Object.keys(missing)) {
    normalized[name] = name === "log" ? "collect logs from trees" : sources[name] ?? "unknown source";
  }
  return normalized;
}
function availableStock(stock, itemName) {
  return stock[itemName] ?? 0;
}
function consumeIngredientStock(state, itemName, count) {
  const available = Math.max(0, state.stock[itemName] ?? 0);
  const used = Math.min(available, count);
  state.stock[itemName] = available - count;
  const initialAvailable = Math.max(0, state.initialStockRemaining[itemName] ?? 0);
  const initialUsed = Math.min(initialAvailable, used);
  state.initialStockRemaining[itemName] = initialAvailable - initialUsed;
  state.initialStockUsed += initialUsed;
}
function orderStepsDependencyFirst(steps) {
  const byItem = /* @__PURE__ */ new Map();
  for (const step of steps) {
    const itemSteps = byItem.get(step.item) ?? [];
    itemSteps.push(step);
    byItem.set(step.item, itemSteps);
  }
  const ordered = [];
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (step) => {
    if (visited.has(step) || visiting.has(step)) return;
    visiting.add(step);
    for (const ingredient of Object.keys(step.ingredients).sort()) {
      for (const dependency of byItem.get(ingredient) ?? []) visit(dependency);
    }
    visiting.delete(step);
    visited.add(step);
    ordered.push(step);
  };
  for (const step of [...steps].sort((left, right) => left.item.localeCompare(right.item))) {
    visit(step);
  }
  return ordered;
}
function parseRecipeEntries(recipe) {
  if (Array.isArray(recipe.inShape)) {
    return recipe.inShape.flat().map((entry) => typeof entry === "number" ? entry : entry?.id ?? null);
  }
  if (Array.isArray(recipe.ingredients)) {
    return recipe.ingredients.map((entry) => typeof entry === "number" ? entry : entry?.id ?? null);
  }
  return [];
}
function isFurnaceRecipe(recipesSource, recipe) {
  const entries = parseRecipeEntries(recipe);
  if (entries.length !== 9) return false;
  const inputId = entries[0];
  if (inputId === null || inputId === void 0) return false;
  if (!entries.every((entry) => entry === inputId)) return false;
  const resultId = recipe.result?.id;
  if (resultId === void 0) return false;
  const inputRecipes = recipesSource?.[inputId];
  if (Array.isArray(inputRecipes)) {
    for (const inputRecipe of inputRecipes) {
      const inputEntries = parseRecipeEntries(inputRecipe);
      const inputResult = inputRecipe.result;
      if (inputEntries.length === 1 && inputEntries[0] === resultId && inputResult?.id === inputId && (inputResult?.count ?? 1) >= 9) {
        return false;
      }
    }
  }
  return true;
}
function smeltInputsFor(registry, itemId, recipesSource) {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const outputName = nameById.get(itemId);
  const candidates = [];
  for (const inputName of outputName ? KNOWN_SMELT_INPUTS[outputName] ?? [] : []) {
    const inputId = registry.itemsByName?.[inputName]?.id;
    if (typeof inputId === "number" && !candidates.includes(inputId)) candidates.push(inputId);
  }
  const source = recipesSource ?? registry?.recipes;
  const recipes = source?.[itemId];
  if (Array.isArray(recipes)) {
    for (const recipe of recipes) {
      if (!isFurnaceRecipe(source, recipe)) continue;
      const inputId = parseRecipeEntries(recipe)[0];
      if (inputId !== null && inputId !== void 0 && nameById.has(inputId) && !candidates.includes(inputId)) {
        candidates.push(inputId);
      }
    }
  }
  return candidates;
}
function smeltInputFor(registry, itemId, recipesSource, availableItems = /* @__PURE__ */ new Map(), requiredAmount = 1) {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const candidates = smeltInputsFor(registry, itemId, recipesSource);
  return candidates.find((inputId) => {
    const inputName = nameById.get(inputId);
    return inputName !== void 0 && (availableItems.get(inputName) ?? 0) >= requiredAmount;
  }) ?? candidates.filter((inputId) => (availableItems.get(nameById.get(inputId) ?? "") ?? 0) > 0).sort((left, right) => (availableItems.get(nameById.get(right) ?? "") ?? 0) - (availableItems.get(nameById.get(left) ?? "") ?? 0))[0] ?? candidates[0];
}
function smeltOutputFor(registry, inputId, recipesSource) {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const inputName = nameById.get(inputId);
  if (inputName) {
    for (const [outputName, sourceNames] of Object.entries(KNOWN_SMELT_INPUTS)) {
      if (sourceNames.includes(inputName)) return registry.itemsByName?.[outputName]?.id;
    }
  }
  const recipes = recipesSource ?? registry?.recipes ?? {};
  for (const [outputIdText, list] of Object.entries(recipes)) {
    if (!Array.isArray(list)) continue;
    for (const recipe of list) {
      if (!isFurnaceRecipe(recipes, recipe)) continue;
      const outputId = Number(outputIdText);
      if (parseRecipeEntries(recipe)[0] === inputId && nameById.has(outputId)) return outputId;
    }
  }
  return void 0;
}
function recipesSourceFor(bot) {
  const version = bot?.version;
  if (version) {
    try {
      return __require("minecraft-data")(version).recipes;
    } catch {
    }
  }
  return bot?.registry?.recipes;
}
function recipeRequiresCraftingTable(recipe) {
  if (Array.isArray(recipe.inShape)) {
    return recipe.inShape.length > 2 || (recipe.inShape[0]?.length ?? 0) > 2;
  }
  return Array.isArray(recipe.ingredients) && recipe.ingredients.length > 4;
}
function scaleIngredients(ingredients, times) {
  if (times <= 0) return {};
  return Object.fromEntries(
    Object.entries(ingredients).map(([name, count]) => [name, count * times]).filter(([, count]) => count > 0)
  );
}
function inventoryCounts(bot) {
  const counts = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    const name = item.name ?? String(item.type);
    counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
  }
  return counts;
}
function itemNamesById(itemsByName) {
  const names = /* @__PURE__ */ new Map();
  for (const [name, item] of Object.entries(itemsByName)) {
    if (typeof item?.id === "number") names.set(item.id, name);
  }
  return names;
}
function createEmptyPlan(targetItem, targetAmount) {
  return {
    targetItem,
    targetAmount,
    steps: [],
    totalRequired: {},
    missing: {},
    sources: {},
    requiresCraftingTable: false,
    canCraftNow: false,
    recipeAvailable: false
  };
}
function normalizeItemName(name, itemsByName) {
  const normalized = name.trim().toLowerCase().replace(/^minecraft\s*[: ]\s*/, "").replace(/[\s-]+/g, "_");
  if (itemsByName[normalized]) return normalized;
  if (normalized === "plank" && itemsByName.planks) return "planks";
  if (normalized.endsWith("_planks") && itemsByName.planks) return "planks";
  if (normalized.endsWith("_plank") && itemsByName.planks) return "planks";
  if (normalized.endsWith("_log") && itemsByName.log) return "log";
  if (normalized.endsWith("_stem") && itemsByName.stem) return "stem";
  return normalized;
}
function sourceHint(registry, itemName, itemId) {
  if (itemId !== void 0) {
    const blocks = Object.entries(registry?.blocksByName ?? {}).filter(([, block]) => recipeDropIds(block).includes(itemId)).map(([name]) => name);
    if (blocks.length > 0) return `mine ${blocks.slice(0, 3).join("/")}`;
  }
  const known = {
    log: "collect logs from trees",
    log2: "collect logs from trees",
    cobblestone: "mine stone",
    coal: "mine coal_ore",
    iron_ingot: "smelt iron_ore",
    gold_ingot: "smelt gold_ore",
    diamond: "mine diamond_ore",
    stick: "craft from planks",
    planks: "craft from logs"
  };
  return known[itemName] ?? "unknown source";
}
function recipeDropIds(block) {
  const ids = [];
  for (const entry of Array.isArray(block?.drops) ? block.drops : []) {
    if (typeof entry === "number") ids.push(entry);
    else if (typeof entry?.drop === "number") ids.push(entry.drop);
    else if (typeof entry?.drop?.id === "number") ids.push(entry.drop.id);
    else if (typeof entry?.id === "number") ids.push(entry.id);
  }
  return ids;
}

// src/hiyori/patchedGoto.ts
import vec3pkg from "vec3";
var { Vec3 } = vec3pkg;
var SPRINT_SPEED = 5.6;
var JUMP_TIME = 0.6;
var PARKOUR_TIME = 1;
var PLACE_TIME = 0.5;
var GRACE_FACTOR = 2;
var BASE_GRACE_S = 10;
var MIN_TIMEOUT_MS = 3e4;
var MAX_TIMEOUT_MS = 3e5;
var PROGRESS_INTERVAL_MS = 5e3;
var STAGNATION_THRESHOLD = 1.5;
var MAX_STAGNANT_TICKS = 3;
var DISTANCE_IMPROVEMENT_THRESHOLD = 0.75;
function hasMeaningfulPathfindingProgress(snapshot) {
  const distanceImprovement = snapshot.previousDistanceToTarget - snapshot.distanceToTarget;
  return snapshot.movedSinceLastTick >= STAGNATION_THRESHOLD || distanceImprovement >= DISTANCE_IMPROVEMENT_THRESHOLD;
}
function estimatePathTimeMs(path) {
  let totalTimeS = 0;
  for (const node of path) {
    totalTimeS += node.toBreak.length * 1.5;
    totalTimeS += node.toPlace.length * PLACE_TIME;
    if (node.parkour) totalTimeS += PARKOUR_TIME;
    else if (node.cost >= 2 && node.toBreak.length === 0 && node.toPlace.length === 0) {
      totalTimeS += JUMP_TIME;
    } else {
      totalTimeS += (node.cost >= 1.4 ? Math.SQRT2 : 1) / SPRINT_SPEED;
    }
  }
  return totalTimeS * 1e3;
}
function computeTimeoutFromEta(estimatedMs) {
  return Math.max(
    MIN_TIMEOUT_MS,
    Math.min(MAX_TIMEOUT_MS, estimatedMs * GRACE_FACTOR + BASE_GRACE_S * 1e3)
  );
}
function coordinate(value) {
  return {
    x: Math.round(Number(value.x) * 10) / 10,
    y: Math.round(Number(value.y) * 10) / 10,
    z: Math.round(Number(value.z) * 10) / 10
  };
}
function patchedGoto(bot, goal, options = {}) {
  return new Promise((resolve) => {
    const startPos = bot.entity.position.clone();
    const startTime = Date.now();
    let lastProgressPos = startPos.clone();
    let stagnantTicks = 0;
    let currentEstimatedMs = 0;
    let currentTimeoutMs = MIN_TIMEOUT_MS;
    let currentPathCost = 0;
    let lastDistanceToTarget = getDistanceToTarget();
    let timeoutTimer;
    let progressTimer;
    let settled = false;
    function getDistanceToTarget() {
      try {
        return typeof goal?.heuristic === "function" ? goal.heuristic(bot.entity.position.floored()) : 0;
      } catch {
        return 0;
      }
    }
    function buildResult(ok, reason, message) {
      const endPos = bot.entity.position.clone();
      return {
        ok,
        reason,
        message,
        startPos: coordinate(startPos),
        endPos: coordinate(endPos),
        distanceTraveled: startPos.distanceTo(endPos),
        distanceToTarget: getDistanceToTarget(),
        elapsedMs: Date.now() - startTime,
        estimatedTimeMs: currentEstimatedMs,
        pathCost: currentPathCost,
        environment: observeEnvironment(bot)
      };
    }
    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      bot.removeListener("goal_reached", onGoalReached);
      bot.removeListener("path_update", onPathUpdate);
      bot.removeListener("goal_updated", onGoalUpdated);
      bot.removeListener("path_stop", onPathStop);
      options.signal?.removeEventListener("abort", onAbort);
    }
    function settle(result) {
      if (settled) return;
      settled = true;
      cleanup();
      setTimeout(resolve, 0, result);
    }
    function resetTimeout() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        settle(buildResult(false, "timeout", `Navigation timed out after ${Math.round((Date.now() - startTime) / 1e3)}s`));
        try {
          bot.pathfinder.setGoal(null);
        } catch {
        }
      }, currentTimeoutMs);
    }
    function onGoalReached() {
      settle(buildResult(true, "success", "Reached the goal"));
    }
    function onPathUpdate(results) {
      if (results.path?.length > 0) {
        currentEstimatedMs = estimatePathTimeMs(results.path);
        currentTimeoutMs = computeTimeoutFromEta(currentEstimatedMs);
        currentPathCost = results.cost;
        resetTimeout();
      }
      if (results.path?.length === 0 && (results.status === "noPath" || results.status === "timeout")) {
        settle(buildResult(false, "noPath", "Pathfinding could not find a path"));
      }
    }
    function onGoalUpdated(nextGoal) {
      if (nextGoal !== goal) settle(buildResult(false, "interrupted", "Goal was changed externally"));
    }
    function onPathStop() {
      settle(buildResult(false, "interrupted", "Path was stopped"));
    }
    function onAbort() {
      settle(buildResult(false, "interrupted", "Navigation was cancelled"));
      try {
        bot.pathfinder.setGoal(null);
      } catch {
      }
    }
    function checkProgress() {
      if (settled) return;
      const currentPos = bot.entity.position.clone();
      const movedSinceLastTick = currentPos.distanceTo(lastProgressPos);
      const distanceToTarget = getDistanceToTarget();
      const madeProgress = hasMeaningfulPathfindingProgress({
        movedSinceLastTick,
        previousDistanceToTarget: lastDistanceToTarget,
        distanceToTarget,
        isMining: bot.pathfinder.isMining() || bot.targetDigBlock != null,
        isBuilding: bot.pathfinder.isBuilding()
      });
      stagnantTicks = madeProgress ? 0 : stagnantTicks + 1;
      if (madeProgress) resetTimeout();
      lastProgressPos = currentPos;
      lastDistanceToTarget = distanceToTarget;
      options.onProgress?.({
        elapsedMs: Date.now() - startTime,
        estimatedTimeMs: currentEstimatedMs,
        distanceTraveled: startPos.distanceTo(currentPos),
        distanceToTarget,
        currentPos: coordinate(currentPos),
        stagnantTicks,
        pathCost: currentPathCost
      });
      if (stagnantTicks >= MAX_STAGNANT_TICKS) {
        settle(buildResult(false, "stagnation", "Bot stagnated for 15s without meaningful movement"));
        try {
          bot.pathfinder.setGoal(null);
        } catch {
        }
      }
    }
    bot.on("goal_reached", onGoalReached);
    bot.on("path_update", onPathUpdate);
    bot.on("goal_updated", onGoalUpdated);
    bot.on("path_stop", onPathStop);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    progressTimer = setInterval(checkProgress, PROGRESS_INTERVAL_MS);
    resetTimeout();
    try {
      bot.pathfinder.setGoal(goal);
    } catch (error) {
      settle(buildResult(false, "error", `Failed to set pathfinding goal: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}
function observeEnvironment(bot) {
  const position = bot.entity?.position;
  if (!position) return { inWater: false, nearbyLiquids: [] };
  const center = typeof position.floored === "function" ? position.floored() : new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
  const offsets = [
    [0, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, 1, 0],
    [0, 1, 1],
    [0, 1, -1]
  ];
  const liquids = /* @__PURE__ */ new Set();
  let inWater = false;
  for (const [x, y, z] of offsets) {
    const block = bot.blockAt?.(center.offset(x, y, z));
    const name = String(block?.name ?? "");
    if (!name.includes("water") && !name.includes("lava")) continue;
    liquids.add(name);
    if (x === 0 && z === 0 && (y === 0 || y === 1)) inWater = name.includes("water");
  }
  const oxygen = Number(bot.oxygenLevel);
  return {
    inWater,
    ...Number.isFinite(oxygen) ? { oxygen } : {},
    nearbyLiquids: [...liquids]
  };
}

// src/hiyori/fluidSafety.ts
import vec3pkg2 from "vec3";
var { Vec3: Vec32 } = vec3pkg2;
var LIQUID_NAMES = /* @__PURE__ */ new Set(["water", "flowing_water", "lava", "flowing_lava"]);
var MAX_VERTICAL_FLOW_LOOKAHEAD = 32;
var FLUID_BREAK_GUARD = Symbol("hiyori-fluid-break-guard");
function assessExcavationFluidRisk(bot, position) {
  const immediateSources = [
    offset(position, 0, 1, 0),
    offset(position, -1, 0, 0),
    offset(position, 1, 0, 0),
    offset(position, 0, 0, -1),
    offset(position, 0, 0, 1)
  ];
  for (const source of immediateSources) {
    const liquid = liquidName(bot.blockAt(source));
    if (liquid) return { unsafe: true, liquid, source };
  }
  for (let dy = 1; dy <= MAX_VERTICAL_FLOW_LOOKAHEAD; dy += 1) {
    const source = offset(position, 0, dy, 0);
    const block = bot.blockAt(source);
    const liquid = liquidName(block);
    if (liquid) return { unsafe: true, liquid, source };
    if (!isFlowPassable(block)) break;
  }
  return { unsafe: false };
}
function protectMovementsFromFluid(bot, movements) {
  const tagged = movements;
  if (tagged[FLUID_BREAK_GUARD]) return movements;
  tagged[FLUID_BREAK_GUARD] = true;
  movements.exclusionAreasBreak ??= [];
  movements.exclusionAreasBreak.push((block) => block?.position && assessExcavationFluidRisk(bot, block.position).unsafe ? 100 : 0);
  return movements;
}
function liquidName(block) {
  const name = String(block?.name ?? "");
  return LIQUID_NAMES.has(name) ? name : void 0;
}
function isFlowPassable(block) {
  if (!block) return false;
  const name = String(block.name ?? "");
  return name === "air" || name === "cave_air" || name === "void_air" || block.boundingBox === "empty";
}
function offset(position, x, y, z) {
  return new Vec32(position.x + x, position.y + y, position.z + z);
}

// src/hiyori/abortableOperation.ts
function runAbortableOperation(operation, signal, cancel) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => {
        try {
          Promise.resolve(cancel?.()).catch(() => void 0);
        } catch {
        }
        reject(createAbortError());
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}
function createAbortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
export {
  assessExcavationFluidRisk,
  patchedGoto,
  planCraft,
  protectMovementsFromFluid,
  recipesSourceFor,
  runAbortableOperation,
  smeltInputFor,
  smeltOutputFor
};
