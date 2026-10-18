// The E2E seeds insert beneficiaries, ration cards and users that look real.
// Pointed at the development database they stay there and show up in the admin
// lists (DEMO-AUDIT-* rows did exactly that). Refuse any database whose name does
// not say it is disposable, unless the operator explicitly overrides it.
export function assertDisposableE2eDatabase(connectionString) {
    if (process.env.E2E_ALLOW_SHARED_DB === '1') return;

    let databaseName;
    try {
        databaseName = new URL(connectionString).pathname.replace(/^\//, '');
    } catch {
        throw new Error('E2E_DATABASE_URL is not a valid connection string.');
    }

    if (!/(test|e2e)/i.test(databaseName)) {
        throw new Error(
            `Refusing to seed database "${databaseName}": its name must contain "test" or "e2e". ` +
                'Point E2E_DATABASE_URL at a disposable database, or set E2E_ALLOW_SHARED_DB=1 to override.',
        );
    }
}
