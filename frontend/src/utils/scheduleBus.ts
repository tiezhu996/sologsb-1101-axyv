/**
 * 轻量类型化事件总线：用于跨 store 的「数据变化 → 排班作废」联动。
 *
 * 背景：repairStore / decayStore / hallStore 是排班数据的上游，
 * scheduleStore 订阅它们发出的变化事件后作废未完成的旧排班。
 * 直接相互 import 会形成循环依赖，因此统一走该总线解耦。
 */

export interface ScheduleEventMap {
  /** 一批病害的严重程度发生变化（档案台单条 / 批量编辑后触发） */
  'decay:severity-changed': { decayIds: string[] }
  /** 彩画层位改挂到别的构件（构件归属变化），参数为受影响层位 id */
  'layer:reassigned': { layerIds: string[] }
  /** 某病害下工序顺序发生拖拽调整或增删导致的顺序变化 */
  'steps:reordered': { decayIds: string[] }
}

type Handler<T> = (payload: T) => void

class ScheduleBus {
  private readonly handlers = new Map<keyof ScheduleEventMap, Set<(payload: unknown) => void>>()

  on<K extends keyof ScheduleEventMap>(event: K, handler: Handler<ScheduleEventMap[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as (payload: unknown) => void)
    return () => this.off(event, handler)
  }

  off<K extends keyof ScheduleEventMap>(event: K, handler: Handler<ScheduleEventMap[K]>): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void)
  }

  emit<K extends keyof ScheduleEventMap>(event: K, payload: ScheduleEventMap[K]): void {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        ;(handler as Handler<ScheduleEventMap[K]>)(payload)
      } catch (err) {
        // 订阅方异常不能阻断主流程（如病害编辑保存）
        console.error(`[scheduleBus] 处理事件 ${event} 失败`, err)
      }
    })
  }
}

export const scheduleBus = new ScheduleBus()
