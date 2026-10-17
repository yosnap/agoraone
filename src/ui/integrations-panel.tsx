import type { HermesCatalog } from '../../shared/hermes-catalog';
import { serviceGroups } from '../data/service-groups';

export function IntegrationsPanel({ catalog, inside, onEnter, onSelect }: { catalog: HermesCatalog; inside: boolean; onEnter: () => void; onSelect: (id: string) => void }) {
  const services = serviceGroups(catalog);
  return <div className="hermes-details">
    {!inside && <button className="primary" onClick={onEnter}>Entrar al centro de integraciones</button>}
    <h3>{services.length} servicios MCP</h3><p>Cada terminal reúne las configuraciones de un mismo nombre. Selecciona después el perfil para consultar sus herramientas.</p>
    {services.map(service => <button key={service.id} className="catalog-link" onClick={() => onSelect(service.id)}>{service.name} · {service.bindings.length} perfiles</button>)}
    {!services.length && <p>Sin MCP declarados en los perfiles detectados.</p>}
  </div>;
}
