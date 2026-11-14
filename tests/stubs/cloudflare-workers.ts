// Stand-in for the Workers runtime module, so the Worker's code can be imported in tests.
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
