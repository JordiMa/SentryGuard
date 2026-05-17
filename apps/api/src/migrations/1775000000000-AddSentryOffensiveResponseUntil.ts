import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSentryOffensiveResponseUntil1775000000000 implements MigrationInterface {
  name = 'AddSentryOffensiveResponseUntil1775000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'vehicles' AND column_name = 'sentry_offensive_response_until'`
    );

    if (hasColumn.length === 0) {
      await queryRunner.query(
        `ALTER TABLE "vehicles" ADD "sentry_offensive_response_until" TIMESTAMP WITH TIME ZONE`
      );
    } else {
      await queryRunner.query(
        `ALTER TABLE "vehicles" ALTER COLUMN "sentry_offensive_response_until" TYPE TIMESTAMP WITH TIME ZONE`
      );
      await queryRunner.query(
        `ALTER TABLE "vehicles" ALTER COLUMN "sentry_offensive_response_until" DROP DEFAULT`
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicles" DROP COLUMN "sentry_offensive_response_until"`
    );
  }
}