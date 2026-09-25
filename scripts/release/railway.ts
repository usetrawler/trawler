export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export class RailwayError extends Error {}

export interface Railway {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

export function railway(projectToken: string, call: typeof fetch = fetch): Railway {
  return {
    async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      const res = await call(RAILWAY_API, {
        method: "POST",
        headers: { "content-type": "application/json", "project-access-token": projectToken },
        body: JSON.stringify({ query: document, variables }),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
      if (!res.ok || body.errors?.length || !body.data) {
        throw new RailwayError(`Railway answered HTTP ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
      }
      return body.data;
    },
  };
}

export interface Target {
  projectId: string;
  environmentId: string;
  service(name: string): string;
}

export async function target(api: Railway): Promise<Target> {
  const { projectToken } = await api.query<{ projectToken: { projectId: string; environmentId: string } }>("query { projectToken { projectId environmentId } }");
  const { project } = await api.query<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
    "query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }",
    { id: projectToken.projectId },
  );
  const services = new Map(project.services.edges.map((e) => [e.node.name, e.node.id]));
  return {
    ...projectToken,
    service(name) {
      const id = services.get(name);
      if (!id) throw new RailwayError(`no service named ${name} in the project behind this token`);
      return id;
    },
  };
}

export async function serviceVariable(api: Railway, at: Target, service: string, name: string): Promise<string | undefined> {
  const { variables } = await api.query<{ variables: Record<string, string> }>(
    "query($proj: String!, $env: String!, $svc: String!) { variables(projectId: $proj, environmentId: $env, serviceId: $svc) }",
    { proj: at.projectId, env: at.environmentId, svc: at.service(service) },
  );
  return variables[name];
}
