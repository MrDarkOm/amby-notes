//! Test-only builder of the three-base workshop of stages 2 to 7. The interface never offers it;
//! tests use it to build a workshop as it was made then and check what `complete_workshop` adds.

use super::create::{create_workshop_of, Env, WorkshopShape};
use super::journal::OP_CREATE_WORKSHOP;
use super::model::{
    CreateWorkshopRequest, CreatedWorkshop, ProjectError, ROLE_CHARACTERS, ROLE_LOCATIONS,
    ROLE_STORIES,
};

const PARTIAL: WorkshopShape = WorkshopShape {
    operation: OP_CREATE_WORKSHOP,
    roles: &[
        (ROLE_STORIES, "Истории"),
        (ROLE_CHARACTERS, "Персонажи"),
        (ROLE_LOCATIONS, "Локации"),
    ],
    takes_empty_folder: false,
};

/// The three-base workshop of stages 2 to 7, for tests of what `complete_workshop` adds to it.
pub(super) fn create_workshop(
    env: &Env,
    request: &CreateWorkshopRequest,
) -> Result<CreatedWorkshop, ProjectError> {
    create_workshop_of(env, request, PARTIAL)
}
