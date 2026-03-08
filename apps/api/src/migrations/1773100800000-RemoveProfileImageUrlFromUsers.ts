import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveProfileImageUrlFromUsers1773100800000
  implements MigrationInterface
{
  name = 'RemoveProfileImageUrlFromUsers1773100800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "profile_image_url"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "profile_image_url" character varying(500)`
    );
  }
}