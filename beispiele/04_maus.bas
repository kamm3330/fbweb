' Malen mit der Maus - linke Taste malt, rechte Taste loescht, ESC beendet
ScreenRes 800, 600, 32
WindowTitle "Malprogramm"
Color RGB(0, 0, 0), RGB(255, 255, 255)
Cls

Dim As Integer mx, my, mb, ox = -1, oy = -1
Dim As ULong farben(0 To 5) = {RGB(0,0,0), RGB(220,40,40), RGB(40,160,40), RGB(40,80,220), RGB(240,180,0), RGB(160,60,200)}
Dim As Integer aktuell = 0

Sub Palette_zeichnen(farben() As ULong, aktuell As Integer)
    For i As Integer = 0 To 5
        Line (10 + i * 40, 10)-(40 + i * 40, 40), farben(i), BF
        Line (10 + i * 40, 10)-(40 + i * 40, 40), IIf(i = aktuell, RGB(0,0,0), RGB(200,200,200)), B
    Next
    Draw String (260, 20), "Links: malen  Rechts: loeschen  ESC: Ende", RGB(80, 80, 80)
End Sub

Palette_zeichnen(farben(), aktuell)
Do
    If GetMouse(mx, my, , mb) = 0 Then
        If (mb And 1) Then
            If my < 45 And mx >= 10 And mx < 250 Then
                aktuell = (mx - 10) \ 40
                Palette_zeichnen(farben(), aktuell)
            ElseIf ox >= 0 Then
                For d As Integer = -2 To 2
                    Line (ox + d, oy)-(mx + d, my), farben(aktuell)
                    Line (ox, oy + d)-(mx, my + d), farben(aktuell)
                Next
            End If
            ox = mx : oy = my
        Else
            ox = -1
        End If
        If (mb And 2) Then Cls : Palette_zeichnen(farben(), aktuell)
    End If
    Sleep 10, 1
Loop Until InKey = Chr(27)
