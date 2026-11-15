' Animation mit Doppelpufferung - ESC beendet
ScreenRes 640, 480, 32, 2
ScreenSet 1, 0
WindowTitle "Ball-Animation (ESC = Ende)"

Type Ball
    As Single x, y, dx, dy
    As ULong farbe
    As Integer r
End Type

Dim As Ball b(1 To 12)
Randomize Timer
For i As Integer = 1 To 12
    With b(i)
        .r = 10 + Int(Rnd * 20)
        .x = 50 + Rnd * 540 : .y = 50 + Rnd * 380
        .dx = (Rnd - 0.5) * 8 : .dy = (Rnd - 0.5) * 8
        .farbe = RGB(80 + Rnd * 175, 80 + Rnd * 175, 80 + Rnd * 175)
    End With
Next

Do
    Cls
    For i As Integer = 1 To 12
        With b(i)
            .x += .dx : .y += .dy
            If .x < .r Or .x > 639 - .r Then .dx = -.dx
            If .y < .r Or .y > 479 - .r Then .dy = -.dy
            Circle (.x, .y), .r, .farbe, , , , F
        End With
    Next
    Draw String (10, 10), "ESC = Ende", RGB(255, 255, 255)
    ScreenCopy
    Sleep 16, 1
Loop Until InKey = Chr(27)
