class_name PauseModal
extends Control

func show_pause(stage_id: int, wave: int) -> void:
	visible = true

func show_result(won: bool, stage_id: int) -> void:
	visible = true

func _ask_quit() -> void:
	var dlg := ConfirmationDialog.new()
	dlg.dialog_text = "Quit?"
	add_child(dlg)
	dlg.popup_centered()
