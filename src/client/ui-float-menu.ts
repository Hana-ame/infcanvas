/**
 * client/ui-float-menu.ts —— RimWorld 原版风格右键上下文菜单 (FloatMenu)
 *  - 支持右键安抚并重新招募因精神崩溃脱离派系的前殖民者 (`recruitWildFormerColonist`)；
 *  - 遗迹搜刮菜单受 `isRuinScavengeDlcEnabled(sim)` 门控（DLC 默认禁用）。
 */
import {
  type Sim,
  assaultNpcBase,
  bandageBodyPartWithHerb,
  ensurePawnAnatomy,
  executeArchitectOrder,
  getDeadPawns,
  getFactionBehaviorByRelation,
  getNpcBases,
  getOutdoorGroundItems,
  getPackBeasts,
  giftNpcBase,
  haulAndButcherCorpse,
  isRuinScavengeDlcEnabled,
  kidnapFromFaction,
  mineralAt,
  orderPawnAttackHostile,
  performPawnTriadAction,
  recruitWildFormerColonist,
  requestAllyReinforcements,
  CULINARY_RECIPES,
  cookCulinaryDish,
  orderScavengeRuinBuilding,
  scavengeRuinBuilding,
  stealFromFaction,
  terrainMetaAt,
} from '../sim';
import {
  breachAncientDangerShrine,
  buryCorpseInSitu,
  dispenseNutrientPasteMeals,
  harvestCorpseOrgan,
  robGrave,
} from '../sim/corpse-youtube-play';
import { constructBlueprint, haulMaterialToBlueprint } from '../sim/rimworld-work';
import { localizeHtml, tr } from './i18n';
import { svgIcon } from './ui-icons';
import { openCorpseLootModal, openFactionTradeModal, openZeroPriceGroupTradeModal } from './ui-modals';
import { cycleFieldCropChoice, getFieldCropChoice } from './ui-schedule-bills';

export interface FloatMenuItem {
  icon?: string;
  label: string;
  action: () => void;
}

export interface FloatMenuCallbacks {
  getSelected: () => Set<number>;
  setSelected: (eids: number[]) => void;
  issueCommand: (type: string, args: Record<string, unknown>) => void;
  showToast: (msg: string) => void;
  forceRefresh: () => void;
  reopenAt: (screenX: number, screenY: number, wx: number, wy: number) => void;
}

let floatMenuListenerBound = false;
let floatMenuFadeTimer: ReturnType<typeof setTimeout> | null = null;
let floatMenuOpenedAtMs = 0;

export function hideRimWorldFloatMenu(): void {
  const menu = document.getElementById('rw-float-menu');
  if (!menu) return;
  if (floatMenuFadeTimer) {
    clearTimeout(floatMenuFadeTimer);
    floatMenuFadeTimer = null;
  }
  menu.classList.remove('rw-float-fading');
  menu.style.opacity = '1';
  menu.hidden = true;
}

function ensureFloatMenuDistanceTracker(): void {
  if (floatMenuListenerBound || typeof window === 'undefined') return;
  floatMenuListenerBound = true;

  window.addEventListener('mousemove', (e) => {
    const menu = document.getElementById('rw-float-menu');
    if (!menu || menu.hidden) return;
    if (performance.now() - floatMenuOpenedAtMs < 80) return;

    const rect = menu.getBoundingClientRect();
    const dx = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right);
    const dy = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom);
    const dist = Math.hypot(dx, dy);

    if (dist <= 36) {
      if (floatMenuFadeTimer) {
        clearTimeout(floatMenuFadeTimer);
        floatMenuFadeTimer = null;
      }
      menu.classList.remove('rw-float-fading');
      menu.style.opacity = '1';
      return;
    }

    const fadeRatio = Math.max(0, Math.min(1, 1 - (dist - 36) / 60));
    menu.style.opacity = fadeRatio.toFixed(2);
    menu.classList.add('rw-float-fading');

    if (dist > 95) {
      hideRimWorldFloatMenu();
      return;
    }

    if (!floatMenuFadeTimer) {
      floatMenuFadeTimer = setTimeout(() => {
        hideRimWorldFloatMenu();
      }, 240);
    }
  });
}

export function openRimWorldFloatMenu(
  x: number,
  y: number,
  items: FloatMenuItem[],
  headerTitle: string | undefined,
  onAfterAction: () => void,
): void {
  ensureFloatMenuDistanceTracker();
  const menu = document.getElementById('rw-float-menu');
  if (!menu) return;
  if (floatMenuFadeTimer) {
    clearTimeout(floatMenuFadeTimer);
    floatMenuFadeTimer = null;
  }
  menu.innerHTML = '';
  menu.classList.remove('rw-float-fading');
  menu.style.opacity = '1';
  floatMenuOpenedAtMs = performance.now();

  menu.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  if (headerTitle) {
    const head = document.createElement('div');
    head.className = 'rw-float-head';
    head.innerHTML = localizeHtml(`${svgIcon('pawn_ratkin', 14)} <span>${tr(headerTitle)}</span>`);
    menu.appendChild(head);
  }

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'rw-float-item';
    btn.innerHTML = localizeHtml(`${svgIcon(item.icon ?? 'move', 16)} <span>${tr(item.label)}</span>`);
    btn.onclick = (ev) => {
      ev.stopPropagation();
      hideRimWorldFloatMenu();
      item.action();
      onAfterAction();
    };
    menu.appendChild(btn);
  }

  menu.hidden = false;
  const menuW = Math.max(240, menu.offsetWidth || 260);
  const menuH = Math.max(80, menu.offsetHeight || 180);
  menu.style.left = `${Math.max(8, Math.min((window.innerWidth || 1280) - menuW - 8, x - 12))}px`;
  menu.style.top = `${Math.max(8, Math.min((window.innerHeight || 720) - menuH - 8, y - 10))}px`;
}

export function handleRimWorldRightClickMenu(
  sim: Sim,
  screenX: number,
  screenY: number,
  wx: number,
  wy: number,
  cb: FloatMenuCallbacks,
): boolean {
  const tx = Math.round(wx);
  const ty = Math.round(wy);
  const tMeta = terrainMetaAt(sim.world, tx, ty);

  const selectedEids = [...cb.getSelected()].filter((id) => {
    const p = sim.pawn(id);
    return Boolean(p && !p.isStranger);
  });

  const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
  const actor = (selectedEids.length > 0 ? sim.pawn(selectedEids[0]) : colonists[0])!;
  if (!actor) return false;

  const activeEids = selectedEids.length > 0 ? selectedEids : [actor.eid];
  const actorLabel = activeEids.length > 1 ? `${actor.name} 等 ${activeEids.length} 人` : actor.name;
  const menuItems: FloatMenuItem[] = [];
  const ruinDlcOn = isRuinScavengeDlcEnabled(sim);

  const walkActorToward = (gx: number, gy: number) => {
    cb.issueCommand('move', { eids: activeEids, x: Math.round(gx), y: Math.round(gy) });
  };

  // 1. 陌生人 / 精神崩溃脱离派系的荒野前殖民者
  for (const p of sim.pawns()) {
    if (p.isStranger && Math.hypot(p.pos.x - wx, p.pos.y - wy) <= 1.8) {
      if (p.formerColonist || p.mentalBreakState === 'wild_man') {
        menuItems.push({
          icon: 'groups',
          label: `安抚并重新招募【${p.name}】回归派系`,
          action: () => {
            walkActorToward(p.pos.x, p.pos.y);
            cb.showToast(recruitWildFormerColonist(sim, p.eid, actor.groupId ?? 'group_alpha').message);
          },
        });
      }
      menuItems.push({
        icon: 'trade',
        label: `与【${p.name}】交易`,
        action: () => {
          walkActorToward(p.pos.x, p.pos.y);
          openFactionTradeModal(sim, 'stranger_caravan', actor.eid, cb.showToast, cb.forceRefresh);
        },
      });
      menuItems.push({
        icon: 'groups',
        label: `与【${p.name}】友好交谈 (+心情)`,
        action: () => {
          walkActorToward(p.pos.x, p.pos.y);
          actor.needs.mood = Math.min(100, actor.needs.mood + 6);
          sim.addRelation(actor.eid, p.eid, 8);
          const res = performPawnTriadAction(actor, 'medical_social', 8, sim.time);
          cb.showToast(`💬 ${actor.name} 与 ${p.name} 交谈（心情 +6 · ${res.message}）`);
        },
      });
    }
  }

  // 2. 其他己方殖民者
  for (const p of sim.pawns()) {
    if (!p.isStranger && p.eid !== actor.eid && Math.hypot(p.pos.x - wx, p.pos.y - wy) <= 1.4) {
      menuItems.push({
        icon: 'medical',
        label: `为【${p.name}】包扎治疗`,
        action: () => {
          walkActorToward(p.pos.x, p.pos.y);
          ensurePawnAnatomy(p);
          const injuredPart = Object.values(p.anatomy ?? {}).find((pt) => pt.hp < pt.maxHp && pt.status !== 'amputated');
          if (injuredPart) {
            cb.showToast(bandageBodyPartWithHerb(sim, p.eid, injuredPart.partId, actor.eid).message);
          } else {
            p.hp = Math.min(p.maxHp, p.hp + 15);
            cb.showToast(`🩹 ${actor.name} 为 ${p.name} 完成了护理（HP ${Math.round(p.hp)}/${p.maxHp}）`);
          }
        },
      });
      menuItems.push({
        icon: 'haul',
        label: `与【${p.name}】调配行囊物资`,
        action: () => {
          walkActorToward(p.pos.x, p.pos.y);
          const gFrom = actor.groupId ?? 'group_alpha';
          const gTo = p.groupId && p.groupId !== gFrom ? p.groupId : gFrom === 'group_alpha' ? 'group_beta' : 'group_alpha';
          openZeroPriceGroupTradeModal(sim, gFrom, gTo, cb.showToast, cb.forceRefresh);
        },
      });
    }
  }

  // 3. 温驯驼兽
  for (const beast of getPackBeasts(sim)) {
    if (Math.hypot(beast.pos.x - wx, beast.pos.y - wy) <= 1.8) {
      menuItems.push({
        icon: 'haul',
        label: `装卸驼兽【${beast.name}】物资`,
        action: () => {
          walkActorToward(beast.pos.x, beast.pos.y);
          openZeroPriceGroupTradeModal(sim, actor.groupId ?? 'group_alpha', 'group_beta', cb.showToast, cb.forceRefresh);
        },
      });
    }
  }

  // 4. 地面遗体 / 猎物尸体
  for (const corpse of getDeadPawns(sim)) {
    if (Math.hypot(corpse.pos.x - wx, corpse.pos.y - wy) <= 1.9) {
      if (!corpse.isAnimalCorpse) {
        const cDist = Math.hypot(actor.pos.x - corpse.pos.x, actor.pos.y - corpse.pos.y);
        menuItems.push({
          icon: 'scavenge',
          label: cDist <= 2.2 ? `贴身搜刮遗体【${corpse.name}】装备物资` : `派遣走近并搜刮【${corpse.name}】(距离 ${cDist.toFixed(1)}格 · 禁隔空)`,
          action: () => {
            if (cDist <= 2.2) {
              openCorpseLootModal(sim, corpse.eid, actor.eid, cb.showToast, cb.forceRefresh);
            } else {
              walkActorToward(corpse.pos.x, corpse.pos.y);
              cb.showToast(`🚶【不能隔空搜刮】已派遣 ${actor.name} 前往【${corpse.name}】旁，走近后再打开遗体搜刮窗！`);
            }
          },
        });
      }
      menuItems.push({
        icon: 'butcher',
        label: `屠宰分解【${corpse.name}】(+生肉/毛皮)`,
        action: () => {
          cb.showToast(haulAndButcherCorpse(sim, corpse.eid, actor.eid).message);
        },
      });
      menuItems.push({
        icon: 'grave',
        label: `原地掩埋【${corpse.name}】`,
        action: () => {
          cb.showToast(buryCorpseInSitu(sim, corpse.eid, actor.eid).message);
        },
      });
      if (!corpse.isAnimalCorpse && !corpse.corpseOrgansHarvested) {
        menuItems.push({
          icon: 'medical',
          label: `提取【${corpse.name}】生物器官`,
          action: () => {
            walkActorToward(corpse.pos.x, corpse.pos.y);
            cb.showToast(harvestCorpseOrgan(sim, corpse.eid).message);
          },
        });
      }
    }
  }

  // 5. 野生动物与敌对袭击者
  for (const h of sim.hostiles()) {
    if (Math.hypot(h.pos.x - wx, h.pos.y - wy) <= 2.0) {
      const hDef = sim.tuning.enemies[h.kind];
      const hName = hDef?.name ?? h.kind;
      if (hDef?.passive) {
        menuItems.push({
          icon: 'hunt',
          label: `狩猎【${hName}】`,
          action: () => {
            orderPawnAttackHostile(sim, activeEids, h.id);
            cb.showToast(`🏹 ${actorLabel} 开始狩猎【${hName}】`);
          },
        });
      } else {
        menuItems.push({
          icon: 'draft',
          label: `集火攻击【${hName}】`,
          action: () => {
            orderPawnAttackHostile(sim, activeEids, h.id);
            cb.showToast(`🎯 ${actorLabel} 正在攻击【${hName}】`);
          },
        });
      }
    }
  }

  // 6. 建筑、蓝图与遗迹建筑（遗迹搜刮仅在开启 dlc-ruin-scavenge 时出现）
  let clickedBld = sim.world.buildingAt(tx, ty);
  if (!clickedBld && ruinDlcOn) {
    for (const b of sim.world.buildings.values()) {
      if (b.isRuinBuilding && Math.hypot(b.pos.x - wx, b.pos.y - wy) <= 1.25) {
        clickedBld = b;
        break;
      }
    }
  }

  if (clickedBld) {
    const bDefId = clickedBld.targetDefId ?? clickedBld.defId;
    const bName = clickedBld.customName ?? sim.tuning.buildings[bDefId]?.name ?? bDefId;

    if (clickedBld.isBlueprint) {
      menuItems.push({
        icon: 'architect',
        label: `优先建造【${bName}】`,
        action: () => {
          walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
          cb.showToast(constructBlueprint(sim, clickedBld!.id, actor.eid, 45).message);
        },
      });
      menuItems.push({
        icon: 'haul',
        label: `运送建材至【${bName}】`,
        action: () => {
          walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
          cb.showToast(haulMaterialToBlueprint(sim, clickedBld!.id, actor.eid).message);
        },
      });
      menuItems.push({
        icon: 'cancel',
        label: `取消【${bName}】蓝图`,
        action: () => {
          cb.showToast(executeArchitectOrder(sim, 'deconstruct', clickedBld!.pos.x, clickedBld!.pos.y, actor.eid).message);
        },
      });
    } else if (clickedBld.isRuinBuilding && ruinDlcOn) {
      if (!clickedBld.scavenged && clickedBld.scavengeLoot && Object.keys(clickedBld.scavengeLoot).length > 0) {
        const lootPreview = Object.entries(clickedBld.scavengeLoot)
          .map(([k, v]) => `${k}×${v}`)
          .join(' ');
        menuItems.push({
          icon: 'scavenge',
          label: `派遣贴身搜刮【${bName}】(${lootPreview} · 禁隔空)`,
          action: () => {
            cb.showToast(orderScavengeRuinBuilding(sim, clickedBld!.id, actor.eid).message);
          },
        });
      }
      if (clickedBld.defId === 'ancient_cryptosleep_casket') {
        menuItems.push({
          icon: 'ancient_cryptosleep_casket',
          label: `破拆开启【${bName}】`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            cb.showToast(breachAncientDangerShrine(sim, clickedBld!.pos.x, clickedBld!.pos.y).message);
          },
        });
      }
      menuItems.push({
        icon: 'deconstruct',
        label: `拆解【${bName}】回收建材`,
        action: () => {
          walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
          cb.showToast(executeArchitectOrder(sim, 'deconstruct', clickedBld!.pos.x, clickedBld!.pos.y, actor.eid).message);
        },
      });
    } else {
      if (clickedBld.defId === 'field') {
        const curCrop = getFieldCropChoice(clickedBld.id);
        menuItems.push({
          icon: 'field',
          label: `切换农田作物（当前：${curCrop.name}）`,
          action: () => {
            const next = cycleFieldCropChoice(clickedBld!.id);
            cb.showToast(`🌱 已将农田切换为种植【${next.name}】`);
          },
        });
      }
      if (clickedBld.defId === 'grave' && !clickedBld.isRobbed) {
        menuItems.push({
          icon: 'skull',
          label: `掘开【${clickedBld.buriedPawnName ?? '坟墓'}】`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            cb.showToast(robGrave(sim, clickedBld!.id, actor.eid).message);
          },
        });
      }
      if (clickedBld.defId === 'butcher_table') {
        menuItems.push({
          icon: 'butcher',
          label: `拖回尸体至此屠宰台分解`,
          action: () => {
            const corpses = getDeadPawns(sim);
            if (corpses.length > 0) {
              cb.showToast(haulAndButcherCorpse(sim, corpses[0].eid, actor.eid).message);
            } else {
              cb.showToast('当前没有可屠宰的尸体');
            }
          },
        });
      }
      if (['shelf', 'storage_cabinet', 'store', 'grand_stockpile_5x5', 'citadel_hub'].includes(clickedBld.defId)) {
        menuItems.push({
          icon: 'trade',
          label: `打开商队贸易窗口`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            openFactionTradeModal(sim, undefined, actor.eid, cb.showToast, cb.forceRefresh);
          },
        });
      }
      if (['stove', 'spice_prep_table', 'campfire', 'great_bonfire', 'nutrient_paste_dispenser'].includes(clickedBld.defId)) {
        if (clickedBld.defId === 'nutrient_paste_dispenser') {
          menuItems.push({
            icon: 'meal',
            label: `在【${bName}】合成应急营养膏`,
            action: () => {
              walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
              cb.showToast(dispenseNutrientPasteMeals(sim, 2).message);
            },
          });
        } else {
          const stationTag = clickedBld.defId as 'stove' | 'spice_prep_table' | 'campfire' | 'great_bonfire';
          const availRecipes = CULINARY_RECIPES.filter((r) => r.stationTags.includes(stationTag)).slice(0, 4);
          for (const rec of availRecipes) {
            menuItems.push({
              icon: rec.id,
              label: `${rec.icon} 烹制【${rec.name}】(${rec.buff.summary})`,
              action: () => {
                walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
                cb.showToast(cookCulinaryDish(sim, rec.id, actor.eid, true).message);
              },
            });
          }
        }
      }
      if (clickedBld.defId === 'ancient_cryptosleep_casket') {
        menuItems.push({
          icon: 'ancient_cryptosleep_casket',
          label: `破拆开启【${bName}】`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            cb.showToast(breachAncientDangerShrine(sim, clickedBld!.pos.x, clickedBld!.pos.y).message);
          },
        });
      }
      if (['bed', 'hut'].includes(clickedBld.defId)) {
        menuItems.push({
          icon: 'bed',
          label: `在【${bName}】躺下休息`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            actor.needs.rest = Math.min(100, actor.needs.rest + 30);
            actor.hp = Math.min(actor.maxHp, actor.hp + 12);
            cb.showToast(`😴 ${actor.name} 前往【${bName}】休息`);
          },
        });
      }
      if (clickedBld.defId === 'research_bench') {
        menuItems.push({
          icon: 'research',
          label: `在【${bName}】研究科技`,
          action: () => {
            walkActorToward(clickedBld!.pos.x, clickedBld!.pos.y);
            cb.showToast(performPawnTriadAction(actor, 'research_craft', 14, sim.time).message);
          },
        });
      }
      menuItems.push({
        icon: 'deconstruct',
        label: `拆除【${bName}】(回收 75% 建材)`,
        action: () => {
          walkActorToward(tx, ty);
          cb.showToast(executeArchitectOrder(sim, 'deconstruct', tx, ty, actor.eid).message);
        },
      });
    }
  }

  // 7. 派系据点
  for (const base of getNpcBases(sim).values()) {
    if (Math.abs(base.pos.x - wx) <= 3.0 && Math.abs(base.pos.y - wy) <= 3.0) {
      const beh = getFactionBehaviorByRelation(base.reputation);
      if (beh.canTrade) {
        menuItems.push({
          icon: 'trade',
          label: `与【${base.name}】贸易`,
          action: () => {
            openFactionTradeModal(sim, base.id, actor.eid, cb.showToast, cb.forceRefresh);
          },
        });
      }
      if (beh.canRequestAid) {
        menuItems.push({
          icon: 'draft',
          label: `呼叫【${base.name}】盟友援军`,
          action: () => {
            cb.showToast(requestAllyReinforcements(sim, base.id).message);
          },
        });
      }
      menuItems.push({
        icon: 'wood',
        label: `向【${base.name}】赠送 10 木材 (+18好感)`,
        action: () => {
          cb.showToast(giftNpcBase(sim, base.id, 'wood', 10).message);
        },
      });
      menuItems.push({
        icon: 'scavenge',
        label: `潜入【${base.name}】盗窃 (-25好感)`,
        action: () => {
          cb.showToast(stealFromFaction(sim, base.id, actor.eid).message);
        },
      });
      menuItems.push({
        icon: 'hunt',
        label: `突袭【${base.name}】绑架 (-45好感)`,
        action: () => {
          cb.showToast(kidnapFromFaction(sim, base.id, actor.eid).message);
        },
      });
      menuItems.push({
        icon: 'draft',
        label: `强攻【${base.name}】`,
        action: () => {
          cb.showToast(assaultNpcBase(sim, base.id).message);
        },
      });
    }
  }

  // 8. 自然树木 (1×1) 与野生浆果丛
  const feat = sim.world.featureAt(tx, ty);
  const isTreeTile = feat?.kind === 'tree' || sim.world.treeBlockAt(tx, ty);
  if (isTreeTile && !clickedBld) {
    menuItems.push({
      icon: 'chop',
      label: `砍伐乔木 (+原木)`,
      action: () => {
        walkActorToward(tx, ty);
        cb.showToast(executeArchitectOrder(sim, 'chop', tx, ty, actor.eid).message);
      },
    });
  } else if (feat?.kind === 'berry' && !clickedBld) {
    menuItems.push({
      icon: 'berry',
      label: `采摘野生浆果 (+浆果)`,
      action: () => {
        walkActorToward(tx, ty);
        cb.showToast(executeArchitectOrder(sim, 'harvest', tx, ty, actor.eid).message);
      },
    });
  }

  // 9. 矿脉
  const minHit = mineralAt(sim.world, tx, ty);
  if (minHit && !clickedBld) {
    menuItems.push({
      icon: 'mine',
      label: `开采【${minHit.name}】(+${minHit.yieldItem})`,
      action: () => {
        walkActorToward(tx, ty);
        cb.showToast(executeArchitectOrder(sim, 'mine', tx, ty, actor.eid).message);
      },
    });
  }

  // 10. 散落地面物资
  for (const [dropId, drop] of getOutdoorGroundItems(sim).entries()) {
    if (Math.hypot(drop.pos.x - wx, drop.pos.y - wy) <= 1.5) {
      menuItems.push({
        icon: 'haul',
        label: `搬运【${drop.item}×${drop.amount}】入库`,
        action: () => {
          walkActorToward(drop.pos.x, drop.pos.y);
          sim.stockpile[drop.item] = (sim.stockpile[drop.item] ?? 0) + drop.amount;
          getOutdoorGroundItems(sim).delete(dropId);
          cb.showToast(`📦 ${actor.name} 已将 ${drop.item}×${drop.amount} 搬回仓库`);
        },
      });
    }
  }

  if (menuItems.length === 0) {
    hideRimWorldFloatMenu();
    if (selectedEids.length > 0) {
      walkActorToward(tx, ty);
      cb.forceRefresh();
    }
    return true;
  }

  menuItems.push({
    icon: 'move',
    label: `移动至 (${tx}, ${ty}) [${tMeta.shortName}]`,
    action: () => {
      walkActorToward(tx, ty);
    },
  });

  const headerTitle = `${actorLabel} ➔ (${tx}, ${ty})`;
  openRimWorldFloatMenu(screenX, screenY, menuItems, headerTitle, cb.forceRefresh);
  return true;
}
