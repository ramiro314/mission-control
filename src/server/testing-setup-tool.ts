/** The Mission MCP tool a testing-setup launch may call to set its repository's affected-tests Command. */
export const SET_AFFECTED_TESTS_COMMAND_TOOL = "set_affected_tests_command" as const;

/** The label every testing-setup task carries, and the one the tool's route requires. */
export const TESTING_SETUP_TASK_LABEL = "testing-setup";

/**
 * The second label a stored-mode testing setup carries. Such a task proposes its Commands as a
 * document for the operator to apply, so the tool's route refuses it: a stored setup never
 * writes a live Command row, whatever its prompt or its permission prompts allowed.
 */
export const TESTING_SETUP_STORED_LABEL = "testing-setup:stored";
