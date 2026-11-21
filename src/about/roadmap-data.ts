/** Where an idea stands. Nothing here is promised: it is what comes next, filled in little by little. */
export type RoadmapStatus = 'doing' | 'planned' | 'idea';

export type RoadmapItem = { title: string; detail: string; area: string; status: RoadmapStatus; version?: string };

// Generic texts only: this file is in the public repository. Move an item to Novedades when it ships.
export const roadmap: RoadmapItem[] = [
  { status: 'planned', area: 'Ajustes', title: 'Registro del servidor y de la app de escritorio', detail: 'Sumar al registro lo que ocurre en el servidor local y en la ventana de escritorio.' },
  { status: 'planned', area: 'Watson', title: 'Guardar una respuesta de Watson como nota', detail: 'Un botón para llevar una buena respuesta al vault, con título, carpeta y texto editables, sin pisar ninguna nota.' },
  { status: 'planned', area: 'Watson', title: 'Respuestas que dicen lo que no saben', detail: 'Cuando falte información, Watson lo dice y enseña de cuándo es la nota más reciente que ha usado.' },
  { status: 'planned', area: 'Cerebro', title: 'Mantenimiento del vault', detail: 'Informe de solo lectura con enlaces rotos, notas casi duplicadas y temas muy enlazados sin nota propia; cada arreglo se propone y se confirma.' },
  { status: 'planned', area: 'Bandeja', title: 'Bucles abiertos del correo', detail: 'Lo que te han pedido y sigue sin respuesta, y lo que pediste tú y nadie ha contestado, sin modelos y en solo lectura.' },
  { status: 'idea', area: 'Watson', title: 'Preferencias aprendidas', detail: 'Que Watson recuerde cómo te gusta trabajar con una confianza medible, y que puedas verlas y corregirlas.' },
  { status: 'idea', area: 'Clientes', title: 'Fichas con resumen y línea de tiempo', detail: 'Cada cliente con un resumen que se actualiza y debajo la historia de correos, reuniones y trabajos.' },
  { status: 'idea', area: 'Trabajos', title: 'Traspaso entre conversaciones y encargos', detail: 'Una nota de traspaso por encargo para retomarlo en otra conversación o con otro agente sin perder el hilo.' },
  { status: 'idea', area: 'Cerebro', title: 'Contradicciones entre notas', detail: 'Avisar cuando dos notas dicen cosas distintas sobre lo mismo, para que decidas cuál vale.' },
  { status: 'idea', area: 'Cerebro', title: 'Carpeta sugerida al archivar', detail: 'Proponer la carpeta de una nota nueva con su grado de confianza y detectar notas mal archivadas.' },
];
