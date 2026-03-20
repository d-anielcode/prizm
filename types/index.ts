// NBA IQ — Centralized TypeScript Types
// ALL types go here. Never use `any`. Use `unknown` with type guards instead.

export interface PlayerStat {
  player_id: number
  player_name: string
  team: string
  game_date: string
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  three_pointers: number
  minutes_played: number
  cached_at?: string
}

export type StatType =
  | 'points'
  | 'rebounds'
  | 'assists'
  | 'pra'
  | 'steals'
  | 'blocks'
  | 'three_pointers'

export type ConfidenceLabel = 'HIGH' | 'MEDIUM' | 'LOW'
export type RiskTier = 'LOW_RISK' | 'MED_RISK' | 'HIGH_RISK'
export type Direction = 'over' | 'under'

export interface Prop {
  id?: string
  player_id: number
  player_name: string
  team: string
  opponent: string
  game_id: string
  stat_type: StatType
  line: number
  direction: Direction
  odds?: number
  sportsbook?: string
  commence_time?: string   // ISO string of game tip-off from odds-api.io
  confidence_score?: number
  confidence_label?: ConfidenceLabel
  confidence_reason?: string
  risk_tier?: RiskTier
  cached_at?: string
  home_team?: string
  away_team?: string
}

export interface AltLine {
  line:              number
  direction:         Direction
  odds?:             number
  sportsbook?:       string
  confidence_score?: number
  confidence_label?: ConfidenceLabel
}

export interface PropWithAlts extends Prop {
  altLines?: AltLine[]
}

export interface Parlay {
  id?: string
  pick_ids: string[]
  picks?: Prop[]
  combined_confidence: number
  estimated_multiplier: number
  risk_tier: RiskTier
  generated_at: string
}

export interface Game {
  id: string
  home_team: string
  away_team: string
  commence_time: string
  props?: Prop[]
}

export interface BDLPlayer {
  id: number
  first_name: string
  last_name: string
  team: {
    abbreviation: string
    full_name: string
  }
}

export interface BDLStatEntry {
  id: number
  date: string
  season: number
  player: BDLPlayer
  team: { abbreviation: string }
  pts: number | null
  reb: number | null
  ast: number | null
  stl: number | null
  blk: number | null
  fg3m: number | null
  min: string | null
}

export interface BDLSeasonAverage {
  player_id: number
  season: number
  pts: number
  reb: number
  ast: number
  stl: number
  blk: number
  fg3m: number
  min: string
}

export interface ConfidenceFactors {
  last10HitRate: number
  seasonAvgDiff: number
  oppDefRank: number
  homeAwayDiff: number
  restDays: number
  lineMovement: number
}
