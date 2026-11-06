' Copyright (c) 2026 Roku, Inc.
' SPDX-License-Identifier: MIT

sub init()
    print "BaseAppScene init"

    di = CreateObject("roDeviceInfo")
    uiResolution = di.GetUIResolution()

    print "uiResolution: "; uiResolution.name

    ' Set a simple background color for the scene
    m.top.backgroundColor = "0x000000FF"

    aquariumScene = m.top.findNode("aquariumScene")
    if aquariumScene <> invalid
        print "AquariumScene component found and initialized"
        aquariumScene.setFocus(true) ' Set initial focus to the AquariumScene component
    else
        print "ERROR: AquariumScene component (id aquariumScene) not found; initial focus not set"
    end if
end sub
