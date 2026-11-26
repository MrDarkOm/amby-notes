//! The dossier layout of a section's page template (docs/road/creative-visual.md §3).

use std::path::Path;

use super::create::Env;
use super::model::{
    DossierTemplate, ProjectError, UpdateDossierTemplateRequest, UpdatedDossierTemplate,
};

pub fn get_dossier_template(
    _vault: &Path,
    _database_id: &str,
) -> Result<DossierTemplate, ProjectError> {
    Err(ProjectError::failed("notImplemented", ""))
}

pub fn update_dossier_template(
    _env: &Env,
    _request: &UpdateDossierTemplateRequest,
) -> Result<UpdatedDossierTemplate, ProjectError> {
    Err(ProjectError::failed("notImplemented", ""))
}
