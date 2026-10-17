import type { ReactNode } from 'react';
import type { ProfileActivity } from '../../shared/hermes-activity';
import { WorldLabel } from './world-label';
import { BoardList, JobList } from '../ui/activity-panel';
import { ago } from '../data/activity-format';

type Vec3 = [number, number, number];

// Two wall boards either side of the portrait, filled only with Hermes' own records.
function Board({ x, title, children }: { x: number; title: string; children: ReactNode }) {
  return <group position={[x, 2.5, -7.8]}>
    <mesh castShadow><boxGeometry args={[2.6, 1.8, 0.06]}/><meshStandardMaterial color="#3a2f24" roughness={0.6}/></mesh>
    <mesh position={[0, 0, 0.035]}><boxGeometry args={[2.44, 1.64, 0.01]}/><meshStandardMaterial color="#efe8d6" roughness={0.95}/></mesh>
    <WorldLabel position={[0, 0.2, 0.3] as Vec3} distanceFactor={9}><div className="room-board"><h4>{title}</h4>{children}</div></WorldLabel>
  </group>;
}

export function ActivityBoards({ activity }: { activity?: ProfileActivity }) {
  const source = <small>Dato real de Hermes · última actividad {ago(activity?.lastActivityAt ?? null)}</small>;
  return <>
    <Board x={-4.5} title="Tareas programadas">{activity ? <JobList jobs={activity.jobs}/> : <p>Sin registros de Hermes.</p>}{source}</Board>
    <Board x={4.5} title="Tablero kanban">{activity ? <BoardList board={activity.board}/> : <p>Sin registros de Hermes.</p>}{source}</Board>
  </>;
}
